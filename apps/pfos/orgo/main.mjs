import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { createServer } from "node:http";
import { AGENT_PROFILES, inferProfileFromTaskType } from "./profiles.mjs";
import { routeDiscordMessage } from "./discord-router.mjs";

const PORT = Number.parseInt(process.env.PF_MAIN_PORT ?? "18791", 10);
const DATA_DIR = resolve(process.env.PF_DATA_DIR ?? "./.pf-data");
const DB_PATH = resolve(process.env.PF_DB_PATH ?? `${DATA_DIR}/orchestrator.sqlite`);
const API_TOKEN = String(process.env.PF_API_TOKEN ?? "").trim();
const DEFAULT_MAX_ATTEMPTS = Number.parseInt(process.env.PF_DEFAULT_MAX_ATTEMPTS ?? "3", 10);
const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.PF_DEFAULT_TIMEOUT_MS ?? "60000", 10);
const SINGLE_WORKER_ID = String(process.env.PF_SINGLE_WORKER_ID ?? "").trim();
const TRADE_LIVE_ENABLED = String(process.env.PF_TRADE_LIVE_ENABLED ?? "0") === "1";
const TRADE_MAX_RISK_PCT = Number.parseFloat(process.env.PF_TRADE_MAX_RISK_PCT ?? "1");
const TRADE_MAX_DAILY_DRAWDOWN_PCT = Number.parseFloat(process.env.PF_TRADE_MAX_DAILY_DRAWDOWN_PCT ?? "3");
const TRADINGVIEW_WEBHOOK_SECRET = String(process.env.PF_TRADINGVIEW_WEBHOOK_SECRET ?? "").trim();

mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS workers (
    id TEXT PRIMARY KEY,
    hostname TEXT NOT NULL,
    capabilities TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'online',
    last_seen_ms INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT NOT NULL DEFAULT 'queued',
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    target_worker_id TEXT,
    assigned_worker_id TEXT,
    result_json TEXT,
    error_text TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    timeout_ms INTEGER NOT NULL DEFAULT 60000,
    lease_expires_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL,
    started_at_ms INTEGER,
    finished_at_ms INTEGER
  );
`);

function columnExists(table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((row) => row.name === column);
}

function ensureColumn(table, column, ddl) {
  if (!columnExists(table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

// Lightweight migration path for early local schemas.
ensureColumn("tasks", "attempts", "attempts INTEGER NOT NULL DEFAULT 0");
ensureColumn("tasks", "max_attempts", "max_attempts INTEGER NOT NULL DEFAULT 3");
ensureColumn("tasks", "timeout_ms", "timeout_ms INTEGER NOT NULL DEFAULT 60000");
ensureColumn("tasks", "lease_expires_at_ms", "lease_expires_at_ms INTEGER");

const upsertWorkerStmt = db.prepare(`
  INSERT INTO workers (id, hostname, capabilities, status, last_seen_ms)
  VALUES (?, ?, ?, 'online', ?)
  ON CONFLICT(id) DO UPDATE SET
    hostname = excluded.hostname,
    capabilities = excluded.capabilities,
    status = 'online',
    last_seen_ms = excluded.last_seen_ms
`);

const heartbeatStmt = db.prepare(`
  UPDATE workers
  SET status = ?, last_seen_ms = ?
  WHERE id = ?
`);

const enqueueTaskStmt = db.prepare(`
  INSERT INTO tasks (status, type, payload, target_worker_id, max_attempts, timeout_ms, created_at_ms)
  VALUES ('queued', ?, ?, ?, ?, ?, ?)
`);

const nextTaskAnyStmt = db.prepare(`
  SELECT id, type, payload, target_worker_id, timeout_ms, attempts, max_attempts
  FROM tasks
  WHERE status = 'queued'
    AND (target_worker_id IS NULL OR target_worker_id = ?)
  ORDER BY created_at_ms ASC
  LIMIT 1
`);

const claimTaskStmt = db.prepare(`
  UPDATE tasks
  SET status = 'in_progress',
      assigned_worker_id = ?,
      started_at_ms = ?,
      lease_expires_at_ms = ?,
      attempts = attempts + 1
  WHERE id = ? AND status = 'queued'
`);

const completeTaskDoneStmt = db.prepare(`
  UPDATE tasks
  SET status = 'done',
      result_json = ?,
      error_text = ?,
      lease_expires_at_ms = NULL,
      finished_at_ms = ?
  WHERE id = ? AND assigned_worker_id = ?
`);

const completeTaskFailedStmt = db.prepare(`
  UPDATE tasks
  SET status = CASE WHEN attempts < max_attempts THEN 'queued' ELSE 'failed' END,
      assigned_worker_id = CASE WHEN attempts < max_attempts THEN NULL ELSE assigned_worker_id END,
      started_at_ms = CASE WHEN attempts < max_attempts THEN NULL ELSE started_at_ms END,
      lease_expires_at_ms = NULL,
      result_json = ?,
      error_text = ?,
      finished_at_ms = CASE WHEN attempts < max_attempts THEN NULL ELSE ? END
  WHERE id = ? AND assigned_worker_id = ?
`);

const readTaskStateStmt = db.prepare(`
  SELECT status, attempts, max_attempts
  FROM tasks
  WHERE id = ?
`);

const requeueExpiredStmt = db.prepare(`
  UPDATE tasks
  SET status = 'queued',
      assigned_worker_id = NULL,
      started_at_ms = NULL,
      lease_expires_at_ms = NULL
  WHERE status = 'in_progress'
    AND lease_expires_at_ms IS NOT NULL
    AND lease_expires_at_ms <= ?
    AND attempts < max_attempts
`);

const failExpiredMaxedStmt = db.prepare(`
  UPDATE tasks
  SET status = 'failed',
      lease_expires_at_ms = NULL,
      error_text = COALESCE(error_text, 'task lease expired'),
      finished_at_ms = ?
  WHERE status = 'in_progress'
    AND lease_expires_at_ms IS NOT NULL
    AND lease_expires_at_ms <= ?
    AND attempts >= max_attempts
`);

const listWorkersStmt = db.prepare(`
  SELECT id, hostname, capabilities, status, last_seen_ms
  FROM workers
  ORDER BY id ASC
`);

const listTasksStmt = db.prepare(`
  SELECT id, status, type, target_worker_id, assigned_worker_id, attempts, max_attempts, timeout_ms, created_at_ms, started_at_ms, finished_at_ms
  FROM tasks
  ORDER BY id DESC
  LIMIT 200
`);

function nowMs() {
  return Date.now();
}

function sendJson(res, statusCode, body) {
  const data = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(data),
  });
  res.end(data);
}

function getToken(req) {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length).trim();
  }
  const headerToken = req.headers["x-pf-token"];
  return typeof headerToken === "string" ? headerToken.trim() : "";
}

function isAuthorized(req) {
  if (!API_TOKEN) return true;
  return getToken(req) === API_TOKEN;
}

function readJson(req) {
  return new Promise((resolveJson, rejectJson) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        rejectJson(new Error("payload too large"));
      }
    });
    req.on("end", () => {
      if (!raw) return resolveJson({});
      try {
        resolveJson(JSON.parse(raw));
      } catch {
        rejectJson(new Error("invalid json"));
      }
    });
    req.on("error", rejectJson);
  });
}

function reapExpiredLeases() {
  const now = nowMs();
  requeueExpiredStmt.run(now);
  failExpiredMaxedStmt.run(now, now);
}

function validateTradingPayload(type, payload) {
  const normalized = String(type ?? "").toLowerCase();
  const isTradingTask = ["trade.", "forex.", "crypto.", "market."].some((prefix) => normalized.startsWith(prefix));
  if (!isTradingTask) return { ok: true };

  const mode = String(payload?.mode ?? "paper").toLowerCase();
  const riskPct = Number.parseFloat(String(payload?.riskPct ?? "0"));
  const dailyDrawdownPct = Number.parseFloat(String(payload?.dailyDrawdownPct ?? "0"));

  if (Number.isFinite(riskPct) && riskPct > TRADE_MAX_RISK_PCT) {
    return { ok: false, error: `riskPct exceeds max (${TRADE_MAX_RISK_PCT}%)` };
  }
  if (Number.isFinite(dailyDrawdownPct) && dailyDrawdownPct > TRADE_MAX_DAILY_DRAWDOWN_PCT) {
    return { ok: false, error: `dailyDrawdownPct exceeds max (${TRADE_MAX_DAILY_DRAWDOWN_PCT}%)` };
  }
  if (mode === "live" && !TRADE_LIVE_ENABLED) {
    return { ok: false, error: "live trading is disabled (set PF_TRADE_LIVE_ENABLED=1 to enable)" };
  }
  if (mode === "live" && payload?.confirmLive !== true) {
    return { ok: false, error: "live trading requires payload.confirmLive=true" };
  }
  return { ok: true };
}

function enqueueTaskRecord({ type, payload, targetWorkerId, maxAttempts, timeoutMs }) {
  return enqueueTaskStmt.run(type, JSON.stringify(payload), targetWorkerId, maxAttempts, timeoutMs, nowMs());
}

function resolveTargetWorkerId(defaultWorkerId, explicitTargetWorkerId = null) {
  if (explicitTargetWorkerId) return explicitTargetWorkerId;
  if (SINGLE_WORKER_ID) return SINGLE_WORKER_ID;
  return defaultWorkerId;
}

function extractTradingViewSecret(req, body, url) {
  const headerSecret = String(req.headers["x-tradingview-secret"] ?? "").trim();
  const bearer = String(req.headers.authorization ?? "").trim();
  const bearerSecret = bearer.startsWith("Bearer ") ? bearer.slice("Bearer ".length).trim() : "";
  const querySecret = String(url.searchParams.get("secret") ?? "").trim();
  const bodySecret = String(body?.secret ?? "").trim();
  return headerSecret || bearerSecret || querySecret || bodySecret;
}

const server = createServer(async (req, res) => {
  try {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    if (method === "GET" && path === "/health") {
      return sendJson(res, 200, {
        ok: true,
        db: DB_PATH,
        ts: nowMs(),
        profiles: Object.values(AGENT_PROFILES).map((p) => ({ id: p.id, workerId: p.workerId })),
        singleWorkerId: SINGLE_WORKER_ID || null,
        tradingviewWebhook: TRADINGVIEW_WEBHOOK_SECRET ? "enabled" : "disabled",
      });
    }

    if (method === "POST" && path === "/tradingview/webhook") {
      const body = await readJson(req);
      if (!TRADINGVIEW_WEBHOOK_SECRET) {
        return sendJson(res, 503, { ok: false, error: "tradingview webhook is not configured" });
      }
      const suppliedSecret = extractTradingViewSecret(req, body, url);
      if (suppliedSecret !== TRADINGVIEW_WEBHOOK_SECRET) {
        return sendJson(res, 401, { ok: false, error: "invalid webhook secret" });
      }

      const payload = {
        provider: "tradingview",
        mode: "paper",
        strategy: body.strategy ?? body.strategyName ?? "tradingview-strategy",
        symbol: body.symbol ?? body.ticker ?? "UNKNOWN",
        timeframe: body.timeframe ?? body.interval ?? "na",
        period: body.period ?? body.range ?? "na",
        returnsR: Array.isArray(body.returnsR) ? body.returnsR : undefined,
        trades: Array.isArray(body.trades) ? body.trades : undefined,
        signals: Array.isArray(body.signals) ? body.signals : undefined,
        raw: body,
      };

      const tradeValidation = validateTradingPayload("trade.backtest.run", payload);
      if (!tradeValidation.ok) {
        return sendJson(res, 400, { ok: false, error: tradeValidation.error });
      }

      const task = enqueueTaskRecord({
        type: "trade.backtest.run",
        payload,
        targetWorkerId: resolveTargetWorkerId(AGENT_PROFILES.trading.workerId),
        maxAttempts: Math.min(20, Math.max(1, Number.parseInt(String(body.maxAttempts ?? DEFAULT_MAX_ATTEMPTS), 10))),
        timeoutMs: Math.min(
          15 * 60 * 1000,
          Math.max(1_000, Number.parseInt(String(body.timeoutMs ?? DEFAULT_TIMEOUT_MS), 10))
        ),
      });
      const targetWorkerId = resolveTargetWorkerId(AGENT_PROFILES.trading.workerId);
      return sendJson(res, 200, {
        ok: true,
        taskId: task.lastInsertRowid,
        profile: AGENT_PROFILES.trading.id,
        targetWorkerId,
      });
    }

    if (!isAuthorized(req)) {
      return sendJson(res, 401, { ok: false, error: "unauthorized" });
    }

    if (method === "POST" && path === "/register") {
      const body = await readJson(req);
      const workerId = String(body.workerId ?? "").trim();
      const hostname = String(body.hostname ?? "").trim();
      const capabilities = Array.isArray(body.capabilities) ? body.capabilities.map(String) : [];
      if (!workerId || !hostname) {
        return sendJson(res, 400, { ok: false, error: "workerId and hostname required" });
      }
      upsertWorkerStmt.run(workerId, hostname, JSON.stringify(capabilities), nowMs());
      return sendJson(res, 200, { ok: true, workerId });
    }

    if (method === "POST" && path === "/heartbeat") {
      const body = await readJson(req);
      const workerId = String(body.workerId ?? "").trim();
      const status = String(body.status ?? "online").trim();
      if (!workerId) {
        return sendJson(res, 400, { ok: false, error: "workerId required" });
      }
      const changed = heartbeatStmt.run(status || "online", nowMs(), workerId).changes;
      if (!changed) return sendJson(res, 404, { ok: false, error: "worker not registered" });
      return sendJson(res, 200, { ok: true });
    }

    if (method === "POST" && path === "/task/enqueue") {
      const body = await readJson(req);
      const type = String(body.type ?? "").trim();
      const payload = body.payload ?? {};
      const inferredProfile = inferProfileFromTaskType(type);
      const explicitTarget =
        body.targetWorkerId === undefined || body.targetWorkerId === null ? null : String(body.targetWorkerId);
      const targetWorkerId = resolveTargetWorkerId(inferredProfile.workerId, explicitTarget);
      const maxAttemptsRaw = Number.parseInt(String(body.maxAttempts ?? DEFAULT_MAX_ATTEMPTS), 10);
      const timeoutMsRaw = Number.parseInt(String(body.timeoutMs ?? DEFAULT_TIMEOUT_MS), 10);
      const maxAttempts = Math.min(20, Math.max(1, maxAttemptsRaw));
      const timeoutMs = Math.min(15 * 60 * 1000, Math.max(1_000, timeoutMsRaw));
      if (!type) return sendJson(res, 400, { ok: false, error: "type required" });

      const tradeValidation = validateTradingPayload(type, payload);
      if (!tradeValidation.ok) {
        return sendJson(res, 400, { ok: false, error: tradeValidation.error });
      }

      const task = enqueueTaskRecord({ type, payload, targetWorkerId, maxAttempts, timeoutMs });
      return sendJson(res, 200, {
        ok: true,
        taskId: task.lastInsertRowid,
        maxAttempts,
        timeoutMs,
        profile: inferredProfile.id,
        targetWorkerId,
      });
    }

    if (method === "POST" && path === "/youtube/publish") {
      const body = await readJson(req);
      const payload = {
        action: body.action ?? "upload",
        title: body.title,
        description: body.description,
        tags: body.tags,
        categoryId: body.categoryId,
        privacyStatus: body.privacyStatus ?? "private",
        videoFilePath: body.videoFilePath,
        mimeType: body.mimeType ?? "video/mp4",
        videoId: body.videoId,
      };
      const maxAttemptsRaw = Number.parseInt(String(body.maxAttempts ?? DEFAULT_MAX_ATTEMPTS), 10);
      const timeoutMsRaw = Number.parseInt(String(body.timeoutMs ?? DEFAULT_TIMEOUT_MS), 10);
      const maxAttempts = Math.min(20, Math.max(1, maxAttemptsRaw));
      const timeoutMs = Math.min(60 * 60 * 1000, Math.max(5_000, timeoutMsRaw));

      const targetWorkerId = resolveTargetWorkerId(AGENT_PROFILES.youtube.workerId);
      const task = enqueueTaskRecord({
        type: "yt.publish.video",
        payload,
        targetWorkerId,
        maxAttempts,
        timeoutMs,
      });
      return sendJson(res, 200, {
        ok: true,
        taskId: task.lastInsertRowid,
        profile: AGENT_PROFILES.youtube.id,
        taskType: "yt.publish.video",
        targetWorkerId,
      });
    }

    if (method === "POST" && path === "/mt5/backtest") {
      const body = await readJson(req);
      const payload = {
        provider: "mt5",
        action: "backtest",
        mode: body.mode ?? "paper",
        strategy: body.strategy ?? "mt5-strategy",
        symbol: body.symbol ?? "EURUSD",
        timeframe: body.timeframe ?? "15m",
        period: body.period ?? "180d",
        riskPct: body.riskPct ?? 0.5,
        dailyDrawdownPct: body.dailyDrawdownPct ?? 1.5,
        parameters: body.parameters ?? {},
      };
      const tradeValidation = validateTradingPayload("trade.backtest.run", payload);
      if (!tradeValidation.ok) {
        return sendJson(res, 400, { ok: false, error: tradeValidation.error });
      }

      const maxAttemptsRaw = Number.parseInt(String(body.maxAttempts ?? DEFAULT_MAX_ATTEMPTS), 10);
      const timeoutMsRaw = Number.parseInt(String(body.timeoutMs ?? DEFAULT_TIMEOUT_MS), 10);
      const targetWorkerId = resolveTargetWorkerId(AGENT_PROFILES.trading.workerId);
      const task = enqueueTaskRecord({
        type: "trade.backtest.run",
        payload,
        targetWorkerId,
        maxAttempts: Math.min(20, Math.max(1, maxAttemptsRaw)),
        timeoutMs: Math.min(60 * 60 * 1000, Math.max(5_000, timeoutMsRaw)),
      });
      return sendJson(res, 200, {
        ok: true,
        taskId: task.lastInsertRowid,
        profile: AGENT_PROFILES.trading.id,
        taskType: "trade.backtest.run",
        targetWorkerId,
      });
    }

    if (method === "POST" && path === "/discord/dispatch") {
      const body = await readJson(req);
      const message = String(body.message ?? "").trim();
      if (!message) return sendJson(res, 400, { ok: false, error: "message required" });

      const route = routeDiscordMessage(message);
      if (!route) return sendJson(res, 400, { ok: false, error: "unable to route message" });

      const maxAttemptsRaw = Number.parseInt(String(body.maxAttempts ?? DEFAULT_MAX_ATTEMPTS), 10);
      const timeoutMsRaw = Number.parseInt(String(body.timeoutMs ?? DEFAULT_TIMEOUT_MS), 10);
      const maxAttempts = Math.min(20, Math.max(1, maxAttemptsRaw));
      const timeoutMs = Math.min(15 * 60 * 1000, Math.max(1_000, timeoutMsRaw));

      const mergedPayload = {
        ...(route.payload ?? {}),
        ...(body.payload ?? {}),
        discord: {
          author: body.author ?? "unknown",
          channelId: body.channelId ?? null,
          messageId: body.messageId ?? null,
        },
      };

      const tradeValidation = validateTradingPayload(route.taskType, mergedPayload);
      if (!tradeValidation.ok) {
        return sendJson(res, 400, { ok: false, error: tradeValidation.error, profile: route.profile.id });
      }

      const targetWorkerId = resolveTargetWorkerId(route.profile.workerId);
      const task = enqueueTaskRecord({
        type: route.taskType,
        payload: mergedPayload,
        targetWorkerId,
        maxAttempts,
        timeoutMs,
      });
      return sendJson(res, 200, {
        ok: true,
        taskId: task.lastInsertRowid,
        profile: route.profile.id,
        taskType: route.taskType,
        targetWorkerId,
      });
    }

    if (method === "POST" && path === "/task/next") {
      const body = await readJson(req);
      const workerId = String(body.workerId ?? "").trim();
      if (!workerId) return sendJson(res, 400, { ok: false, error: "workerId required" });

      reapExpiredLeases();

      const row = nextTaskAnyStmt.get(workerId);
      if (!row) return sendJson(res, 200, { ok: true, task: null });

      const startedAt = nowMs();
      const leaseExpiresAt = startedAt + Number(row.timeout_ms);
      const claimed = claimTaskStmt.run(workerId, startedAt, leaseExpiresAt, row.id).changes;
      if (!claimed) return sendJson(res, 200, { ok: true, task: null });

      return sendJson(res, 200, {
        ok: true,
        task: {
          id: row.id,
          type: row.type,
          payload: JSON.parse(row.payload),
          targetWorkerId: row.target_worker_id,
          timeoutMs: row.timeout_ms,
          attempt: Number(row.attempts) + 1,
          maxAttempts: row.max_attempts,
        },
      });
    }

    if (method === "POST" && path === "/task/result") {
      const body = await readJson(req);
      const workerId = String(body.workerId ?? "").trim();
      const taskId = Number.parseInt(String(body.taskId ?? ""), 10);
      const status = String(body.status ?? "done");
      const result = body.result ?? {};
      const errorText = body.error ? String(body.error) : null;
      if (!workerId || !Number.isFinite(taskId)) {
        return sendJson(res, 400, { ok: false, error: "workerId and taskId required" });
      }
      const finishedAt = nowMs();
      const isFailed = status === "failed";
      const changes = isFailed
        ? completeTaskFailedStmt.run(JSON.stringify(result), errorText, finishedAt, taskId, workerId).changes
        : completeTaskDoneStmt.run(JSON.stringify(result), errorText, finishedAt, taskId, workerId).changes;
      if (!changes) return sendJson(res, 404, { ok: false, error: "task not found for worker" });

      const state = readTaskStateStmt.get(taskId);
      return sendJson(res, 200, {
        ok: true,
        finalStatus: state?.status ?? null,
        attempts: state?.attempts ?? null,
        maxAttempts: state?.max_attempts ?? null,
      });
    }

    if (method === "GET" && path === "/workers") {
      const rows = listWorkersStmt.all().map((row) => ({
        ...row,
        capabilities: JSON.parse(row.capabilities),
      }));
      return sendJson(res, 200, { ok: true, workers: rows });
    }

    if (method === "GET" && path === "/tasks") {
      const tasks = listTasksStmt.all();
      return sendJson(res, 200, { ok: true, tasks });
    }

    if (method === "GET" && path === "/profiles") {
      return sendJson(res, 200, { ok: true, profiles: AGENT_PROFILES });
    }

    return sendJson(res, 404, { ok: false, error: "not found" });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : "internal error" });
  }
});

server.listen(PORT, () => {
  console.log(
    JSON.stringify({
      ok: true,
      role: "main",
      port: PORT,
      db: DB_PATH,
      auth: API_TOKEN ? "token" : "disabled",
      defaultMaxAttempts: DEFAULT_MAX_ATTEMPTS,
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      tradeLiveEnabled: TRADE_LIVE_ENABLED,
      tradeMaxRiskPct: TRADE_MAX_RISK_PCT,
      tradeMaxDailyDrawdownPct: TRADE_MAX_DAILY_DRAWDOWN_PCT,
      singleWorkerId: SINGLE_WORKER_ID || null,
      tradingviewWebhook: TRADINGVIEW_WEBHOOK_SECRET ? "enabled" : "disabled",
    })
  );
});
