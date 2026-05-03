#!/usr/bin/env node
// Standalone MCP bridge server. Hand-bundled as a single ESM file so it can
// run directly via `node serve.mjs` without going through the openclaw build
// pipeline. Mirrors the logic in src/mcp-server.ts; keep them in sync.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// -- Gateway client --------------------------------------------------------

const DEFAULT_GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL ?? "http://127.0.0.1:18789";
const DEFAULT_AUTOSTART = process.env.OPENCLAW_BRIDGE_AUTOSTART !== "false";
const DEFAULT_WARMUP_S = Number(process.env.OPENCLAW_BRIDGE_WARMUP_SECONDS ?? "5");
const DEFAULT_OPENCLAW_BIN = process.env.OPENCLAW_BIN ?? "openclaw";

// -- LCM direct read access ------------------------------------------------
// Read-only access to ~/.openclaw/lcm.db for lcm_grep / lcm_describe surfaces.
// The lossless-claw plugin's tools are only registered in-process to embedded
// agents, so external MCP clients (Claude Code, Codex CLI) need their own path
// to recall historical context. node:sqlite can safely open lcm.db read-only
// alongside the gateway's own writer connection.

const LCM_DB_PATH = process.env.LCM_DATABASE_PATH ?? path.join(os.homedir(), ".openclaw", "lcm.db");

let lcmDbConnection = null;

function getLcmDb() {
  if (lcmDbConnection) return lcmDbConnection;
  lcmDbConnection = new DatabaseSync(LCM_DB_PATH, { readOnly: true });
  return lcmDbConnection;
}

async function lcmGrepDirect({ pattern, sessionId, limit = 20 }) {
  try {
    const db = getLcmDb();
    let rows;
    if (sessionId) {
      rows = db
        .prepare(
          `SELECT m.conversation_id, m.seq, m.role,
                  substr(m.content, 1, 500) AS excerpt,
                  length(m.content) AS bytes,
                  c.session_id
           FROM messages_fts f
           JOIN messages m ON m.message_id = f.rowid
           JOIN conversations c ON c.conversation_id = m.conversation_id
           WHERE f.content MATCH ? AND c.session_id = ?
           ORDER BY m.conversation_id, m.seq
           LIMIT ?`,
        )
        .all(pattern, sessionId, limit);
    } else {
      rows = db
        .prepare(
          `SELECT m.conversation_id, m.seq, m.role,
                  substr(m.content, 1, 500) AS excerpt,
                  length(m.content) AS bytes,
                  c.session_id
           FROM messages_fts f
           JOIN messages m ON m.message_id = f.rowid
           JOIN conversations c ON c.conversation_id = m.conversation_id
           WHERE f.content MATCH ?
           ORDER BY m.conversation_id, m.seq
           LIMIT ?`,
        )
        .all(pattern, limit);
    }
    const distinctConversations = new Set(rows.map((r) => r.conversation_id)).size;
    return {
      ok: true,
      hits: rows.length,
      conversations: distinctConversations,
      results: rows,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function lcmDescribeDirect({ sessionId }) {
  try {
    const db = getLcmDb();
    const conv = db
      .prepare(
        `SELECT conversation_id, session_id, title, bootstrapped_at, created_at, updated_at
         FROM conversations WHERE session_id = ?`,
      )
      .get(sessionId);
    if (!conv) {
      return { ok: false, error: `no conversation in lcm.db for sessionId=${sessionId}` };
    }
    const counts = db
      .prepare(
        `SELECT COUNT(*) AS message_count,
                MIN(seq) AS first_seq,
                MAX(seq) AS last_seq,
                SUM(token_count) AS total_tokens
         FROM messages WHERE conversation_id = ?`,
      )
      .get(conv.conversation_id);
    const recentTail = db
      .prepare(
        `SELECT seq, role, substr(content, 1, 200) AS excerpt
         FROM messages WHERE conversation_id = ?
         ORDER BY seq DESC LIMIT 3`,
      )
      .all(conv.conversation_id);
    return {
      ok: true,
      conversation: conv,
      message_count: counts?.message_count ?? 0,
      first_seq: counts?.first_seq ?? null,
      last_seq: counts?.last_seq ?? null,
      total_tokens: counts?.total_tokens ?? 0,
      recent_tail: recentTail,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// -- Bench Harness Manifest (opt-in) ---------------------------------------
// When BENCH_HARNESS_MANIFEST_ENFORCE=true, wiki.search / wiki.get responses
// are filtered through the approved-slug allowlist published by the super-admin
// at benchagi.com/api/v1/admin/harness/manifest. Default off — behavior
// unchanged for anyone who hasn't opted in.

const HARNESS_MANIFEST_ENFORCE = process.env.BENCH_HARNESS_MANIFEST_ENFORCE === "true";
const HARNESS_MANIFEST_URL =
  process.env.BENCH_HARNESS_MANIFEST_URL ?? "https://benchagi.com/api/v1/admin/harness/manifest";
const HARNESS_MANIFEST_KEY = process.env.BENCH_HARNESS_MANIFEST_KEY ?? "";
const HARNESS_MANIFEST_CEILING = process.env.BENCH_HARNESS_MANIFEST_CEILING ?? "orange";
const HARNESS_MANIFEST_REFRESH_MS = Number(
  process.env.BENCH_HARNESS_MANIFEST_REFRESH_MS ?? "300000",
);

let harnessAllowedSlugs = null; // null = unknown/no-manifest → fail open; Set → enforce
let harnessManifestVersion = 0;
let harnessManifestRefreshTimer = null;

function normalizeWikiPath(value) {
  if (typeof value !== "string") {
    return null;
  }
  return value.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\.md$/i, "");
}

async function fetchHarnessManifest() {
  if (!HARNESS_MANIFEST_ENFORCE) {
    return;
  }
  try {
    const url = new URL(HARNESS_MANIFEST_URL);
    url.searchParams.set("rarityCeiling", HARNESS_MANIFEST_CEILING);
    const headers = { Accept: "application/json" };
    if (HARNESS_MANIFEST_KEY) {
      headers["X-API-Key"] = HARNESS_MANIFEST_KEY;
    }
    const res = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      process.stderr.write(`[harness-manifest] fetch ${res.status}: ${res.statusText}\n`);
      return;
    }
    const body = await res.json();
    const slugs = new Set();
    if (Array.isArray(body?.entries)) {
      for (const entry of body.entries) {
        const norm = normalizeWikiPath(entry?.slug);
        if (norm) {
          slugs.add(norm);
        }
      }
    } else if (Array.isArray(body?.manifest?.approvedSlugs)) {
      for (const slug of body.manifest.approvedSlugs) {
        const norm = normalizeWikiPath(slug);
        if (norm) {
          slugs.add(norm);
        }
      }
    }
    harnessAllowedSlugs = slugs;
    harnessManifestVersion =
      typeof body?.manifest?.manifestVersion === "number" ? body.manifest.manifestVersion : 0;
    process.stderr.write(
      `[harness-manifest] loaded v${harnessManifestVersion} with ${slugs.size} approved slugs (ceiling=${HARNESS_MANIFEST_CEILING})\n`,
    );
  } catch (err) {
    process.stderr.write(`[harness-manifest] fetch error: ${err?.message ?? String(err)}\n`);
  }
}

function scheduleHarnessManifestRefresh() {
  if (!HARNESS_MANIFEST_ENFORCE) {
    return;
  }
  if (harnessManifestRefreshTimer) {
    clearInterval(harnessManifestRefreshTimer);
  }
  harnessManifestRefreshTimer = setInterval(() => {
    void fetchHarnessManifest();
  }, HARNESS_MANIFEST_REFRESH_MS);
  harnessManifestRefreshTimer.unref?.();
}

function isHarnessAllowedSlug(value) {
  if (!HARNESS_MANIFEST_ENFORCE) {
    return true;
  } // not enforcing
  if (harnessAllowedSlugs === null) {
    return true;
  } // manifest not loaded yet — fail open
  const norm = normalizeWikiPath(value);
  if (!norm) {
    return false;
  }
  if (harnessAllowedSlugs.has(norm)) {
    return true;
  }
  // Tolerate nested paths: a slug "inbox/foo" should match a lookup of
  // "inbox/foo.md" (already stripped) or the title embedded in a path.
  for (const allowed of harnessAllowedSlugs) {
    if (norm === allowed || norm.endsWith(`/${allowed}`) || allowed.endsWith(`/${norm}`)) {
      return true;
    }
  }
  return false;
}

function filterSearchResultByManifest(payload) {
  if (!HARNESS_MANIFEST_ENFORCE || harnessAllowedSlugs === null) {
    return payload;
  }
  if (!payload || typeof payload !== "object") {
    return payload;
  }
  const data = payload.data ?? payload;
  if (!data || typeof data !== "object") {
    return payload;
  }
  const results = Array.isArray(data.results)
    ? data.results
    : Array.isArray(data.matches)
      ? data.matches
      : Array.isArray(data.items)
        ? data.items
        : null;
  if (!results) {
    return payload;
  }

  let filteredCount = 0;
  const filtered = results.filter((row) => {
    const candidate = row?.path ?? row?.slug ?? row?.title ?? row?.lookup ?? row?.id ?? null;
    const allowed = isHarnessAllowedSlug(candidate);
    if (!allowed) {
      filteredCount += 1;
    }
    return allowed;
  });

  if (filteredCount === 0) {
    return payload;
  }

  const next = { ...data };
  if (Array.isArray(data.results)) {
    next.results = filtered;
  }
  if (Array.isArray(data.matches)) {
    next.matches = filtered;
  }
  if (Array.isArray(data.items)) {
    next.items = filtered;
  }
  next._harnessManifest = {
    version: harnessManifestVersion,
    filteredOut: filteredCount,
    ceiling: HARNESS_MANIFEST_CEILING,
  };

  return payload.data !== undefined ? { ...payload, data: next } : next;
}

async function fetchGatewayHealth() {
  try {
    const res = await fetch(new URL("/healthz", DEFAULT_GATEWAY_URL), {
      method: "GET",
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) {
      return { up: false };
    }
    const body = await res.json().catch(() => null);
    if (!body) {
      return { up: true };
    }
    return {
      up: true,
      agents: typeof body.agents === "number" ? body.agents : undefined,
      version: typeof body.version === "string" ? body.version : undefined,
      raw: body,
    };
  } catch {
    return { up: false };
  }
}

async function ensureGatewayUp() {
  const initial = await fetchGatewayHealth();
  if (initial.up || !DEFAULT_AUTOSTART) {
    return initial;
  }
  spawnDetached(DEFAULT_OPENCLAW_BIN, ["gateway", "start", "--detach"]);
  const deadline = Date.now() + DEFAULT_WARMUP_S * 1_000;
  while (Date.now() < deadline) {
    await delay(500);
    const probe = await fetchGatewayHealth();
    if (probe.up) {
      return probe;
    }
  }
  return { up: false };
}

async function callGatewayMethod(method, params, opts = {}) {
  // openclaw CLI's own timeout defaults to 10s — pass --timeout so it matches
  // our wrapper budget (minus 2s buffer so openclaw can exit cleanly before
  // our hard kill).
  const wrapperTimeoutMs = opts.timeoutMs ?? 15_000;
  const innerTimeoutMs = Math.max(2_000, wrapperTimeoutMs - 2_000);
  const args = ["gateway", "call", method, "--json", "--timeout", String(innerTimeoutMs)];
  if (opts.expectFinal) {
    args.push("--expect-final");
  }
  if (params !== undefined) {
    args.push("--params", JSON.stringify(params));
  }
  // Strip OPENCLAW_GATEWAY_URL so openclaw uses its local config + bundled
  // bearer token. Setting --url puts the CLI into "explicit credentials
  // required" mode, which we'd then have to satisfy by reading the token
  // out of openclaw.json ourselves.
  const childEnv = { ...process.env };
  delete childEnv.OPENCLAW_GATEWAY_URL;
  const res = await runCommand(DEFAULT_OPENCLAW_BIN, args, {
    timeoutMs: wrapperTimeoutMs,
    env: childEnv,
  });
  if (res.exitCode !== 0) {
    return {
      ok: false,
      error: res.stderr.trim() || `openclaw exited with code ${res.exitCode}`,
      exitCode: res.exitCode,
      stderr: res.stderr,
    };
  }
  const trimmed = res.stdout.trim();
  if (trimmed.length === 0) {
    return { ok: true, data: null, exitCode: 0, stderr: res.stderr };
  }
  try {
    return { ok: true, data: JSON.parse(trimmed), exitCode: 0, stderr: res.stderr };
  } catch {
    return { ok: true, data: trimmed, exitCode: 0, stderr: res.stderr };
  }
}

function runCommand(command, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: opts.env ?? process.env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGKILL");
      resolve({ exitCode: 124, stdout, stderr: stderr + `\n[timeout after ${opts.timeoutMs}ms]` });
    }, opts.timeoutMs);
    child.stdout.on("data", (c) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c) => (stderr += c.toString("utf8")));
    child.on("error", (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: 127, stdout, stderr: stderr + `\n[spawn error: ${err.message}]` });
    });
    child.on("exit", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

function spawnDetached(command, args) {
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    // swallow — caller polls health, that's the source of truth
  }
}

// -- Inbox -----------------------------------------------------------------

const INBOX_PATH =
  process.env.OPENCLAW_BRIDGE_INBOX_PATH ??
  path.join(os.homedir(), ".openclaw", "wiki", "main", "inbox.md");
const DEDUPE_WINDOW_MS = Number(process.env.OPENCLAW_BRIDGE_DEDUPE_WINDOW_S ?? "60") * 1_000;
const recentAppends = new Map();

async function appendToInbox({ note, source = "claude-code", tags = [], sessionId = "anonymous" }) {
  const trimmed = note.trim();
  if (trimmed.length === 0) {
    throw new Error("inbox.append: note must be non-empty");
  }
  const dedupeKey = `${sessionId}:${createHash("sha256").update(trimmed).digest("hex")}`;
  const now = Date.now();
  for (const [k, e] of recentAppends) {
    if (now - e.appendedAt > DEDUPE_WINDOW_MS * 4) {
      recentAppends.delete(k);
    }
  }
  const existing = recentAppends.get(dedupeKey);
  if (existing && now - existing.appendedAt < DEDUPE_WINDOW_MS) {
    return {
      ok: true,
      path: INBOX_PATH,
      byteOffset: -1,
      byteLength: 0,
      dedupedFrom: {
        sessionId: existing.sessionId,
        appendedAt: new Date(existing.appendedAt).toISOString(),
      },
    };
  }
  const ts = new Date(now).toISOString();
  const tagsLine = tags.length > 0 ? `\n[tags: ${tags.join(", ")}]` : "";
  const block = `\n## ${ts} — ${source} (session: ${sessionId})\n${trimmed}${tagsLine}\n---\n`;
  await fs.mkdir(path.dirname(INBOX_PATH), { recursive: true });
  const handle = await fs.open(INBOX_PATH, "a");
  let offset;
  try {
    const stat = await handle.stat();
    offset = stat.size;
    await handle.appendFile(block, "utf8");
  } finally {
    await handle.close();
  }
  recentAppends.set(dedupeKey, { appendedAt: now, sessionId });
  return {
    ok: true,
    path: INBOX_PATH,
    byteOffset: offset,
    byteLength: Buffer.byteLength(block, "utf8"),
  };
}

// -- Heartbeat awareness ---------------------------------------------------
// Check if a target agent is within its scheduled active hours. The check is
// advisory: agents will respond to user-initiated messages outside their
// heartbeat window, but the wake-up may incur unexpected model cost.

import { promises as fsPromises } from "node:fs";

const OPENCLAW_HOME = process.env.OPENCLAW_HOME ?? path.join(os.homedir(), ".openclaw");
const OPENCLAW_CONFIG_PATH = path.join(OPENCLAW_HOME, "openclaw.json");

let cachedAgentSchedules = null;
let cachedAgentSchedulesAt = 0;
const AGENT_SCHEDULES_TTL_MS = 60_000;

async function loadAgentSchedules() {
  if (cachedAgentSchedules && Date.now() - cachedAgentSchedulesAt < AGENT_SCHEDULES_TTL_MS) {
    return cachedAgentSchedules;
  }
  try {
    const raw = await fsPromises.readFile(OPENCLAW_CONFIG_PATH, "utf8");
    const cfg = JSON.parse(raw);
    const list = Array.isArray(cfg?.agents?.list) ? cfg.agents.list : [];
    const map = new Map();
    for (const a of list) {
      if (typeof a?.id !== "string") {
        continue;
      }
      const hb = a.heartbeat ?? {};
      const ah = hb.activeHours ?? {};
      map.set(a.id, {
        agentId: a.id,
        defaultAgent: Boolean(a.default),
        identityName: a?.identity?.name,
        activeStart: typeof ah.start === "string" ? ah.start : null,
        activeEnd: typeof ah.end === "string" ? ah.end : null,
        timezone: typeof ah.timezone === "string" ? ah.timezone : "America/Denver",
      });
    }
    cachedAgentSchedules = map;
    cachedAgentSchedulesAt = Date.now();
    return map;
  } catch {
    cachedAgentSchedules = new Map();
    cachedAgentSchedulesAt = Date.now();
    return cachedAgentSchedules;
  }
}

function checkHeartbeatWindow(schedule) {
  if (!schedule || !schedule.activeStart || !schedule.activeEnd) {
    return { inWindow: true, scheduled: false };
  }
  const tz = schedule.timezone;
  let nowInTz;
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    const parts = fmt.formatToParts(new Date());
    const h = parts.find((p) => p.type === "hour")?.value ?? "00";
    const m = parts.find((p) => p.type === "minute")?.value ?? "00";
    nowInTz = `${h}:${m}`;
  } catch {
    return { inWindow: true, scheduled: false };
  }
  const inWindow = nowInTz >= schedule.activeStart && nowInTz <= schedule.activeEnd;
  return {
    inWindow,
    scheduled: true,
    nowInTz,
    activeStart: schedule.activeStart,
    activeEnd: schedule.activeEnd,
    timezone: tz,
  };
}

// -- Default agent resolution ----------------------------------------------

async function resolveAgentId(agentIdOrAlias) {
  const map = await loadAgentSchedules();
  if (agentIdOrAlias && map.has(agentIdOrAlias)) {
    return agentIdOrAlias;
  }
  if (!agentIdOrAlias) {
    for (const [id, sched] of map) {
      if (sched.defaultAgent) {
        return id;
      }
    }
    // first agent if no default flag
    const first = map.keys().next().value;
    if (first) {
      return first;
    }
  }
  return agentIdOrAlias ?? null;
}

// -- MCP server ------------------------------------------------------------

function jsonResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function buildServer() {
  const server = new McpServer({
    name: "openclaw-claude-code-bridge",
    version: "0.1.0",
  });

  server.registerTool(
    "openclaw_gateway_health",
    {
      description:
        "Check whether the local OpenClaw gateway is reachable. Returns up/agents/version. Auto-starts the gateway if configured.",
      inputSchema: {},
    },
    async () => jsonResult(await ensureGatewayUp()),
  );

  server.registerTool(
    "openclaw_agent_list",
    {
      description: "List all OpenClaw agents (id, model, workspace, identity, default flag).",
      inputSchema: {},
    },
    async () => {
      await ensureGatewayUp();
      return jsonResult(await callGatewayMethod("agents.list"));
    },
  );

  server.registerTool(
    "openclaw_skill_list",
    {
      description:
        "List skills available to an OpenClaw agent. Defaults to the default agent (kestrel-aurelius).",
      inputSchema: {
        agentId: z
          .string()
          .optional()
          .describe("Agent id (e.g., 'kestrel-aurelius'). Omit to use the default agent."),
      },
    },
    async ({ agentId }) => {
      await ensureGatewayUp();
      const params = {};
      if (agentId) {
        params.agentId = agentId;
      }
      return jsonResult(await callGatewayMethod("skills.status", params));
    },
  );

  server.registerTool(
    "openclaw_wiki_search",
    {
      description:
        "Search the OpenClaw memory wiki. Returns ranked passages with path, score, excerpt. " +
        "By default, staged dreaming candidates with confidence below min_confidence (default 0.3) " +
        "are excluded — pass include_staged:true to see them. Raise min_confidence to tighten the floor.",
      inputSchema: {
        query: z.string().min(1).describe("Free-text search query."),
        corpus: z
          .enum(["all", "wiki", "memory"])
          .optional()
          .describe("Restrict to a corpus subset. Defaults to vault config."),
        backend: z
          .enum(["shared", "local"])
          .optional()
          .describe("Search backend. Defaults to vault config."),
        limit: z.number().int().min(1).max(50).optional().describe("Max results."),
        min_confidence: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe(
            "Confidence floor (0..1) for staged dreaming candidates. Defaults to 0.3. Ignored when include_staged is true.",
          ),
        include_staged: z
          .boolean()
          .optional()
          .describe(
            "If true, return staged candidates regardless of confidence. Defaults to false.",
          ),
      },
    },
    async ({ query, corpus, backend, limit, min_confidence, include_staged }) => {
      await ensureGatewayUp();
      const params = { query };
      if (corpus) {
        params.corpus = corpus;
      }
      if (backend) {
        params.backend = backend;
      }
      if (limit) {
        params.maxResults = limit;
      }
      if (typeof min_confidence === "number") {
        params.minConfidence = min_confidence;
      }
      if (typeof include_staged === "boolean") {
        params.includeStaged = include_staged;
      }
      const raw = await callGatewayMethod("wiki.search", params);
      return jsonResult(filterSearchResultByManifest(raw));
    },
  );

  server.registerTool(
    "openclaw_wiki_get",
    {
      description:
        "Fetch a wiki page by title or vault-relative path. Optional fromLine/lineCount for paged reads.",
      inputSchema: {
        lookup: z
          .string()
          .min(1)
          .describe("Page title or vault-relative path (e.g., 'inbox' or 'sources/foo.md')."),
        fromLine: z.number().int().min(1).optional().describe("1-indexed start line."),
        lineCount: z
          .number()
          .int()
          .min(1)
          .max(2000)
          .optional()
          .describe("Number of lines to return."),
      },
    },
    async ({ lookup, fromLine, lineCount }) => {
      await ensureGatewayUp();
      if (!isHarnessAllowedSlug(lookup)) {
        return jsonResult({
          ok: false,
          error: "wiki entry not in harness manifest allowlist",
          manifestVersion: harnessManifestVersion,
          ceiling: HARNESS_MANIFEST_CEILING,
        });
      }
      const params = { lookup };
      if (fromLine !== undefined) {
        params.fromLine = fromLine;
      }
      if (lineCount !== undefined) {
        params.lineCount = lineCount;
      }
      return jsonResult(await callGatewayMethod("wiki.get", params));
    },
  );

  server.registerTool(
    "openclaw_wiki_inbox_append",
    {
      description:
        "Append a note to the OpenClaw wiki inbox. The dream cycle absorbs new entries on its next pass.",
      inputSchema: {
        note: z.string().min(1).describe("The note to append. Markdown allowed."),
        source: z.string().optional().describe("Source label. Defaults to 'claude-code'."),
        tags: z.array(z.string()).optional().describe("Optional tags for indexing."),
        sessionId: z
          .string()
          .optional()
          .describe("Optional session id. Used for deduplication within the dedupe window."),
      },
    },
    async ({ note, source, tags, sessionId }) => {
      return jsonResult(await appendToInbox({ note, source, tags, sessionId }));
    },
  );

  server.registerTool(
    "openclaw_agent_handoff",
    {
      description:
        "Hand a brief to an OpenClaw agent. Creates a fresh session with the initial message and returns a sessionKey you can use with openclaw_agent_messages to read replies. Defaults to the default agent (kestrel-aurelius). Async by default — agent reply may take 30+ seconds for Opus 4.6 thinking.",
      inputSchema: {
        message: z.string().min(1).describe("The brief / initial message to send."),
        agentId: z
          .string()
          .optional()
          .describe(
            "Target agent id (e.g., 'kestrel-aurelius', 'cole', 'sage'). Omit for default.",
          ),
        label: z.string().optional().describe("Optional session label for later identification."),
        force: z
          .boolean()
          .optional()
          .describe(
            "If true, bypass the heartbeat-window warning. Defaults to false (warn but proceed).",
          ),
      },
    },
    async ({ message, agentId, label, force }) => {
      await ensureGatewayUp();
      const resolvedAgentId = await resolveAgentId(agentId);
      if (!resolvedAgentId) {
        return jsonResult({ ok: false, error: "no agent matched (and no default configured)" });
      }
      const schedules = await loadAgentSchedules();
      const sched = schedules.get(resolvedAgentId);
      const window = checkHeartbeatWindow(sched);
      const params = { agentId: resolvedAgentId, message };
      if (label) {
        params.label = label;
      }
      const create = await callGatewayMethod("sessions.create", params, { timeoutMs: 30_000 });
      return jsonResult({
        ...create,
        agentId: resolvedAgentId,
        agentName: sched?.identityName ?? resolvedAgentId,
        heartbeatWindow: window,
        warning:
          window.scheduled && !window.inWindow && !force
            ? `${sched?.identityName ?? resolvedAgentId} is outside her active hours (${window.activeStart}-${window.activeEnd} ${window.timezone}); reply may be delayed. Pass force:true to suppress this warning.`
            : undefined,
      });
    },
  );

  server.registerTool(
    "openclaw_agent_send",
    {
      description:
        "Send a follow-up message to an existing OpenClaw agent session. Use the sessionKey returned by openclaw_agent_handoff.",
      inputSchema: {
        sessionKey: z
          .string()
          .min(1)
          .describe("Session key from a previous handoff (format: 'agent:<id>:<channel>:<uuid>')."),
        message: z.string().min(1).describe("The follow-up message."),
        thinking: z
          .string()
          .optional()
          .describe("Optional thinking-level override ('low','medium','high')."),
      },
    },
    async ({ sessionKey, message, thinking }) => {
      await ensureGatewayUp();
      const params = { key: sessionKey, message };
      if (thinking) {
        params.thinking = thinking;
      }
      const result = await callGatewayMethod("sessions.send", params, { timeoutMs: 30_000 });
      return jsonResult(result);
    },
  );

  server.registerTool(
    "openclaw_agent_messages",
    {
      description:
        "Fetch recent messages from an OpenClaw agent session. Use the sessionKey returned by openclaw_agent_handoff. Returns user/assistant turns with timestamps. Poll this to see when the agent has replied.",
      inputSchema: {
        sessionKey: z.string().min(1).describe("Session key from a previous handoff."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Max messages to return. Default 10."),
      },
    },
    async ({ sessionKey, limit }) => {
      await ensureGatewayUp();
      const params = { sessionKey };
      if (limit) {
        params.limit = limit;
      }
      const result = await callGatewayMethod("chat.history", params, { timeoutMs: 15_000 });
      return jsonResult(result);
    },
  );

  server.registerTool(
    "openclaw_wiki_status",
    {
      description:
        "Report the OpenClaw wiki bridge status: artifact count, last bridge run, healthy flag.",
      inputSchema: {},
    },
    async () => {
      await ensureGatewayUp();
      return jsonResult(await callGatewayMethod("wiki.status"));
    },
  );

  server.registerTool(
    "openclaw_lcm_grep",
    {
      description:
        "Full-text search the LCM transcript store via FTS5. Returns matching message excerpts with conversation_id, seq, role, source session_id, and per-row excerpt. Reads ~/.openclaw/lcm.db directly (no gateway round-trip). Quote phrases with double-quotes for exact-phrase matching; supports AND/OR/NOT; # and - are special, quote them.",
      inputSchema: {
        pattern: z
          .string()
          .min(1)
          .describe(
            "FTS5 query. Examples: 'aurelius', '\"Phase D2 monorepo\"', 'hammer AND anvil', '\"#477\"'.",
          ),
        sessionId: z
          .string()
          .optional()
          .describe(
            "Optional: scope to a single session by sessionId (UUID). Default: search all conversations.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max results. Default 20, max 100."),
      },
    },
    async ({ pattern, sessionId, limit }) => {
      return jsonResult(await lcmGrepDirect({ pattern, sessionId, limit }));
    },
  );

  server.registerTool(
    "openclaw_lcm_describe",
    {
      description:
        "Describe an LCM conversation by sessionId. Returns the conversation row + message_count + first/last seq + total tokens + recent message tail. Reads ~/.openclaw/lcm.db directly.",
      inputSchema: {
        sessionId: z
          .string()
          .min(1)
          .describe(
            "Runtime sessionId (UUID). Find via openclaw sessions list or sessions.json. Example: 22a78faf-3e7d-4f0f-bef4-2ab2790bae76.",
          ),
      },
    },
    async ({ sessionId }) => {
      return jsonResult(await lcmDescribeDirect({ sessionId }));
    },
  );

  return server;
}

// -- Entrypoint ------------------------------------------------------------

const args = process.argv.slice(2);

if (args.includes("--once-list-tools")) {
  const descriptors = [
    {
      name: "openclaw_gateway_health",
      description: "Check OpenClaw gateway reachability (auto-starts if down).",
    },
    { name: "openclaw_agent_list", description: "List OpenClaw agents." },
    { name: "openclaw_skill_list", description: "List skills for an OpenClaw agent." },
    { name: "openclaw_wiki_search", description: "Search the OpenClaw memory wiki." },
    { name: "openclaw_wiki_get", description: "Fetch a wiki page." },
    { name: "openclaw_wiki_inbox_append", description: "Append a note to the inbox." },
    {
      name: "openclaw_agent_handoff",
      description: "Hand a brief to an OpenClaw agent (creates a fresh session).",
    },
    { name: "openclaw_agent_send", description: "Send a follow-up to an existing agent session." },
    {
      name: "openclaw_agent_messages",
      description: "Fetch recent messages from an agent session.",
    },
    { name: "openclaw_wiki_status", description: "Report wiki bridge status." },
    {
      name: "openclaw_lcm_grep",
      description: "Full-text search the LCM transcript store (FTS5).",
    },
    {
      name: "openclaw_lcm_describe",
      description: "Describe an LCM conversation by sessionId.",
    },
  ];
  process.stdout.write(JSON.stringify(descriptors, null, 2) + "\n");
  process.exit(0);
}

const server = buildServer();
const transport = new StdioServerTransport();

// Load the harness manifest before accepting MCP requests when enforcement is
// enabled. Fire-and-forget the refresh loop; individual calls tolerate a null
// allowlist by failing open, so a slow initial fetch never deadlocks startup.
if (HARNESS_MANIFEST_ENFORCE) {
  await fetchHarnessManifest();
  scheduleHarnessManifestRefresh();
  process.on("SIGHUP", () => {
    void fetchHarnessManifest();
  });
}

await server.connect(transport);
