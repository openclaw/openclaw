import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import WebSocket from "ws";
import type { AgentInfo } from "./telegram-ui/agent-panel.js";
import type { CronJobInfo } from "./telegram-ui/cron-panel.js";
import type { SystemSnapshot } from "./telegram-ui/main-menu.js";
import type { ModelInfo } from "./telegram-ui/model-panel.js";

type GatewayRecord = Record<string, unknown>;

type RuntimeConfigApi = {
  runtime?: {
    config?: {
      current?: () => unknown;
    };
  };
};

export type GatewaySessionInfo = {
  key: string;
  displayName?: string;
  label?: string;
  updatedAt?: number | null;
  hasActiveRun?: boolean;
  modelProvider?: string;
  model?: string;
  totalTokens?: number;
  spawnedBy?: string;
};

export type GatewayTailLogEntry = {
  ts: number;
  level: string;
  message: string;
};

export type GatewayTailLogsResult = {
  ok: boolean;
  logs: GatewayTailLogEntry[];
  error?: string;
};

// ── Device Identity 處理 ────────────────────────────────────────────

type DeviceIdentity = {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
};

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const key = crypto.createPublicKey(publicKeyPem);
  const spki = key.export({ type: "spki", format: "der" }) as Buffer;
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function signPayload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, Buffer.from(payload, "utf8"), key);
  return base64UrlEncode(sig);
}

function publicKeyRawBase64Url(publicKeyPem: string): string {
  return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}

function resolveRepoRootStateDirCandidate(): string | null {
  const repoRootFromEnv = process.env.OPENCLAW_REPO_ROOT?.trim();
  if (repoRootFromEnv) {
    return path.resolve(repoRootFromEnv, ".openclaw");
  }
  try {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(moduleDir, "..", "..", "..", ".openclaw");
  } catch {
    return null;
  }
}

function resolveOpenClawStateDir(): string {
  const { existsSync } = require("node:fs") as typeof import("node:fs");
  const homeStateDir = path.join(process.env.HOME || process.env.USERPROFILE || ".", ".openclaw");
  const cwdStateDir = path.resolve(process.cwd(), ".openclaw");
  const repoRootStateDir = resolveRepoRootStateDirCandidate();
  const configuredStateDir = process.env.OPENCLAW_STATE_DIR
    ? path.resolve(process.env.OPENCLAW_STATE_DIR)
    : null;
  const configPathStateDir = process.env.OPENCLAW_CONFIG_PATH
    ? path.resolve(path.dirname(process.env.OPENCLAW_CONFIG_PATH))
    : null;
  const candidates = [
    configuredStateDir,
    configPathStateDir,
    repoRootStateDir,
    cwdStateDir,
    homeStateDir,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "openclaw.json"))) {
      return candidate;
    }
  }
  return candidates[0] ?? homeStateDir;
}

function loadDeviceIdentity(stateDir = resolveOpenClawStateDir()): DeviceIdentity | null {
  try {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const idPath = path.join(stateDir, "identity", "device.json");
    const raw = JSON.parse(readFileSync(idPath, "utf8"));
    if (raw?.deviceId && raw?.publicKeyPem && raw?.privateKeyPem) {
      return {
        deviceId: raw.deviceId,
        publicKeyPem: raw.publicKeyPem,
        privateKeyPem: raw.privateKeyPem,
      };
    }
  } catch {
    /* identity 不存在 */
  }
  return null;
}

function buildDeviceAuthPayloadV3(p: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token: string | null;
  nonce: string;
  platform: string;
}): string {
  return [
    "v3",
    p.deviceId,
    p.clientId,
    p.clientMode,
    p.role,
    p.scopes.join(","),
    String(p.signedAtMs),
    p.token ?? "",
    p.nonce,
    p.platform,
    "", // deviceFamily
  ].join("|");
}

// ── Loopback WebSocket RPC client ───────────────────────────────────

type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const DEFAULT_GATEWAY_PORT = 18789;
const REQUEST_TIMEOUT_MS = 12_000;

function resolveGatewayWsUrl(): string {
  const port = Number(process.env.OPENCLAW_GATEWAY_PORT) || DEFAULT_GATEWAY_PORT;
  return `ws://127.0.0.1:${port}/ws`;
}

function resolveGatewayToken(api: OpenClawPluginApi): string | undefined {
  const stateDir = resolveOpenClawStateDir();
  // 1. 優先使用同一 state-dir 的 device operator token（Gateway challenge 預期來源）
  try {
    const deviceToken = resolveDeviceOperatorToken(stateDir);
    if (deviceToken) {
      return deviceToken;
    }
  } catch {
    /* ignore */
  }
  // 2. 嘗試從 plugin runtime config 讀取 gateway.auth.token
  try {
    const cfg = (api as OpenClawPluginApi & RuntimeConfigApi).runtime?.config?.current?.();
    const tok = gatewayTokenFromConfig(cfg);
    if (tok) {
      return tok;
    }
  } catch {
    /* ignore */
  }
  // 3. 直接讀 state-dir 下的 openclaw.json（含 BOM 處理）
  try {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const cfgPath = path.join(stateDir, "openclaw.json");
    let raw = readFileSync(cfgPath, "utf8");
    // 移除 BOM
    if (raw.charCodeAt(0) === 0xfeff) {
      raw = raw.slice(1);
    }
    const cfg = JSON.parse(raw);
    const tok = gatewayTokenFromConfig(cfg);
    if (tok) {
      return tok;
    }
  } catch {
    /* ignore */
  }
  // 4. 最後才使用環境變數，避免 shell 內殘留舊 token 污染本機 loopback RPC
  const envTok = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (typeof envTok === "string" && envTok.trim().length > 0) {
    return envTok.trim();
  }
  return undefined;
}

/**
 * 從 paired.json 取得本機設備的 operator token。
 * Gateway challenge-response 認證時會比對此 token，
 * 與 openclaw.json 的 gateway.auth.token 不同。
 */
function resolveDeviceOperatorToken(stateDir = resolveOpenClawStateDir()): string | undefined {
  try {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    // 載入 device identity
    const idPath = path.join(stateDir, "identity", "device.json");
    const identity = JSON.parse(readFileSync(idPath, "utf8"));
    if (!recordValue(identity)?.deviceId) {
      return undefined;
    }

    // 載入配對設備列表
    const pairedPath = path.join(stateDir, "devices", "paired.json");
    const paired = JSON.parse(readFileSync(pairedPath, "utf8"));
    const identityRecord = recordValue(identity);
    const deviceId = optionalText(identityRecord?.deviceId);
    if (!deviceId) {
      return undefined;
    }
    const pairedRecord = recordValue(paired);
    const myDevice = recordValue(pairedRecord?.[deviceId]);
    const tokens = recordValue(myDevice?.tokens);
    const operator = recordValue(tokens?.operator);
    const token = operator?.token;
    return typeof token === "string" && token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

function gatewayTokenFromConfig(value: unknown): string | undefined {
  const cfg = recordValue(value);
  const gateway = recordValue(cfg?.gateway);
  const auth = recordValue(gateway?.auth);
  const token = auth?.token;
  return typeof token === "string" && token.length > 0 ? token : undefined;
}

function webSocketDataToString(data: WebSocket.Data): string {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return "";
}

/**
 * Loopback WebSocket RPC client — 使用 OpenClaw 協定格式
 * { type: "req", id, method, params } / { type: "res", id, ok, payload?, error? }
 * 包含完整 device identity challenge-response 認證。
 */
class LoopbackGatewayClient {
  private ws: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();

  constructor(
    private readonly url: string,
    private readonly token: string | undefined,
    private readonly device: DeviceIdentity | null,
  ) {}

  private async ensureConnected(): Promise<WebSocket> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return this.ws;
    }
    if (this.connecting) {
      await this.connecting;
      return this.ws!;
    }
    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url);
      let settled = false;
      const settle = (err?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        this.connecting = null;
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      };

      socket.on("open", () => {
        this.ws = socket;
      });

      socket.on("message", (data: WebSocket.Data) => {
        const raw = webSocketDataToString(data);
        let msg: unknown;
        try {
          msg = JSON.parse(raw);
        } catch {
          return;
        }
        const parsed = recordValue(msg);
        if (!parsed) {
          return;
        }

        // 收到 connect.challenge — 建構帶 device identity 的 connect 請求
        if (parsed.type === "event" && parsed.event === "connect.challenge") {
          const payload = recordValue(parsed.payload);
          const nonce = typeof payload?.nonce === "string" ? payload.nonce : "";
          this.sendConnectWithAuth(socket, nonce, settle);
          return;
        }

        // RPC 回應
        if (parsed.type === "res" && typeof parsed.id === "string") {
          this.handleResponse(parsed);
        }
      });

      socket.on("close", () => {
        this.ws = null;
        this.rejectAll(new Error("gateway ws closed"));
        settle(new Error("gateway ws closed before open"));
      });

      socket.on("error", (err: Error) => settle(err));
    });
    await this.connecting;
    return this.ws!;
  }

  private sendConnectWithAuth(
    socket: WebSocket,
    nonce: string,
    settle: (err?: Error) => void,
  ): void {
    const connectId = this.nextId++;
    const role = "operator";
    const scopes = [
      "operator.admin",
      "operator.approvals",
      "operator.pairing",
      "operator.read",
      "operator.write",
    ];
    const signedAtMs = Date.now();

    const connectParams: Record<string, unknown> = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: "gateway-client",
        displayName: "superclaw-internal",
        version: "1.0.0",
        platform: process.platform,
        mode: "backend",
      },
      role,
      scopes,
      caps: [],
    };

    // 認證：device identity + token
    if (this.device) {
      const signatureToken = this.token ?? null;
      const authPayload = buildDeviceAuthPayloadV3({
        deviceId: this.device.deviceId,
        clientId: "gateway-client",
        clientMode: "backend",
        role,
        scopes,
        signedAtMs,
        token: signatureToken,
        nonce,
        platform: process.platform,
      });
      const signature = signPayload(this.device.privateKeyPem, authPayload);
      connectParams.device = {
        id: this.device.deviceId,
        publicKey: publicKeyRawBase64Url(this.device.publicKeyPem),
        signature,
        signedAt: signedAtMs,
        nonce,
      };
      if (this.token) {
        connectParams.auth = { token: this.token };
      }
    } else if (this.token) {
      connectParams.auth = { token: this.token };
    }

    this.pending.set(connectId, {
      resolve: () => settle(),
      reject: (err) => settle(err instanceof Error ? err : new Error(String(err))),
      timeout: setTimeout(() => {
        this.pending.delete(connectId);
        settle(new Error("gateway connect timeout"));
      }, REQUEST_TIMEOUT_MS),
    });

    socket.send(
      JSON.stringify({
        type: "req",
        id: String(connectId),
        method: "connect",
        params: connectParams,
      }),
    );
  }

  async call(method: string, params?: unknown): Promise<unknown> {
    const socket = await this.ensureConnected();
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`gateway RPC timeout: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timeout });
      socket.send(JSON.stringify({ type: "req", id: String(id), method, params }));
    });
  }

  private handleResponse(parsed: GatewayRecord): void {
    const id = Number(parsed.id);
    if (!Number.isFinite(id)) {
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(id);
    if (parsed.ok === false || parsed.error) {
      const errorRecord = recordValue(parsed.error);
      const code = textValue(errorRecord?.code, "unknown");
      const message = textValue(errorRecord?.message, "unknown error");
      pending.reject(new Error(`RPC error ${code}: ${message}`));
    } else {
      pending.resolve(parsed.payload);
    }
  }

  private rejectAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timeout);
      p.reject(err);
    }
    this.pending.clear();
  }

  destroy(): void {
    if (this.ws) {
      try {
        this.ws.close(1000, "plugin shutdown");
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.rejectAll(new Error("client destroyed"));
  }
}

/** 共享 loopback client 實例 */
let loopbackClient: LoopbackGatewayClient | null = null;

function getLoopbackClient(api: OpenClawPluginApi): LoopbackGatewayClient {
  if (!loopbackClient) {
    const stateDir = resolveOpenClawStateDir();
    loopbackClient = new LoopbackGatewayClient(
      resolveGatewayWsUrl(),
      resolveGatewayToken(api),
      loadDeviceIdentity(stateDir),
    );
  }
  return loopbackClient;
}

export async function callGatewayCompat<T>(
  api: OpenClawPluginApi,
  method: string,
  params?: unknown,
): Promise<T> {
  return (await getLoopbackClient(api).call(method, params)) as T;
}

export class GatewayRPC {
  constructor(private api: OpenClawPluginApi) {}

  async fetchAgents(): Promise<AgentInfo[]> {
    try {
      const agents = await callGatewayCompat<GatewayRecord[]>(this.api, "agents.list");
      return agents.map((a) => {
        const status = textValue(a.status, "idle");
        return {
          id: textValue(a.id ?? a.agentId, "unknown"),
          name: textValue(a.name ?? a.id, "Agent"),
          status: status === "running" ? "running" : status === "error" ? "error" : "idle",
          model: optionalText(a.model ?? a.modelId),
          sessionTurns: optionalNumber(a.sessionTurns),
        };
      });
    } catch {
      return [
        { id: "main", name: "Claude (Brain)", status: "idle" },
        { id: "coder", name: "Codex (Hands)", status: "idle" },
      ];
    }
  }

  async fetchActiveAgentId(): Promise<string> {
    try {
      const identity = await callGatewayCompat<GatewayRecord>(this.api, "agent.identity.get");
      return textValue(identity.agentId, "main");
    } catch {
      return "main";
    }
  }

  async fetchCronJobs(): Promise<CronJobInfo[]> {
    try {
      const raw = await callGatewayCompat<unknown>(this.api, "cron.list");
      // Gateway 回傳 {jobs: [...]} 包裝格式
      const jobs: GatewayRecord[] = Array.isArray(raw)
        ? raw
        : Array.isArray((raw as GatewayRecord)?.jobs)
          ? ((raw as GatewayRecord).jobs as GatewayRecord[])
          : [];
      return jobs.map((j) => {
        const schedule = recordValue(j.schedule);
        const payload = recordValue(j.payload);
        const lastRun = recordValue(j.lastRun);
        const lastStatus = optionalText(lastRun?.status);
        return {
          id: textValue(j.id, "unknown"),
          enabled: optionalBoolean(j.enabled) ?? true,
          schedule: textValue(schedule?.expr ?? j.schedule, ""),
          timezone: optionalText(schedule?.tz),
          nextRun: optionalText(j.nextRun),
          description: optionalText(payload?.message),
          lastResult:
            lastStatus === "ok" ? "success" : lastStatus === "error" ? "failure" : undefined,
        };
      });
    } catch {
      return [];
    }
  }

  async toggleCronJob(id: string, enabled: boolean): Promise<void> {
    await callGatewayCompat(this.api, "cron.update", { id, enabled });
  }

  async runCronJob(id: string): Promise<void> {
    await callGatewayCompat(this.api, "cron.run", { id });
  }

  async fetchModels(): Promise<ModelInfo[]> {
    try {
      const models = await callGatewayCompat<GatewayRecord[]>(this.api, "models.list");
      return models.map((m) => ({
        id: textValue(m.id ?? m.modelId, "unknown"),
        name: textValue(m.name ?? m.displayName ?? m.id, "Model"),
        provider: textValue(m.provider, "unknown"),
        isCurrent: optionalBoolean(m.isCurrent) ?? false,
      }));
    } catch {
      return [];
    }
  }

  async fetchCurrentModel(): Promise<string | undefined> {
    try {
      const models = await this.fetchModels();
      return models.find((m) => m.isCurrent)?.id;
    } catch {
      return undefined;
    }
  }

  async switchModel(modelId: string): Promise<void> {
    await callGatewayCompat(this.api, "sessions.patch", { model: modelId });
  }

  async switchAgent(agentId: string): Promise<void> {
    await callGatewayCompat(this.api, "config.patch", {
      path: "agents.default",
      value: agentId,
    });
  }

  async resetSession(): Promise<void> {
    await callGatewayCompat(this.api, "sessions.reset", {});
  }

  async fetchSystemSnapshot(): Promise<SystemSnapshot> {
    try {
      const [agents, cronJobs] = await Promise.all([this.fetchAgents(), this.fetchCronJobs()]);

      const activeAgent = agents.find((a) => a.status === "running");
      const enabledCrons = cronJobs.filter((j) => j.enabled).length;

      return {
        agentStatus: activeAgent ? `${activeAgent.name} 運行中` : "待命中",
        activeWorkflows: 0,
        pendingApprovals: 0,
        cronJobsEnabled: enabledCrons,
      };
    } catch {
      return {
        agentStatus: "狀態未知",
        activeWorkflows: 0,
        pendingApprovals: 0,
        cronJobsEnabled: 0,
      };
    }
  }

  async fetchApprovals(): Promise<Array<{ id: string; description: string }>> {
    try {
      const list = await callGatewayCompat<GatewayRecord[]>(this.api, "exec.approval.list");
      return list.map((a) => ({
        id: textValue(a.id ?? a.approvalId, "unknown"),
        description: textValue(a.description ?? a.command, "pending operation"),
      }));
    } catch {
      return [];
    }
  }

  async approveExecution(id: string): Promise<void> {
    await callGatewayCompat(this.api, "exec.approval.resolve", { id, decision: "approve" });
  }

  async denyExecution(id: string): Promise<void> {
    await callGatewayCompat(this.api, "exec.approval.resolve", { id, decision: "deny" });
  }

  async fetchHealth(): Promise<{ ok: boolean; details?: string }> {
    try {
      const health = await callGatewayCompat<GatewayRecord>(this.api, "health");
      return { ok: optionalBoolean(health.ok) ?? true, details: optionalText(health.message) };
    } catch (err: unknown) {
      return { ok: false, details: err instanceof Error ? err.message : undefined };
    }
  }

  async fetchUsage(): Promise<{ tokensToday: number; costToday: number }> {
    try {
      const usage = await callGatewayCompat<GatewayRecord>(this.api, "usage.status");
      return {
        tokensToday: numberValue(usage.tokensToday, 0),
        costToday: numberValue(usage.costToday, 0),
      };
    } catch {
      return { tokensToday: 0, costToday: 0 };
    }
  }

  async fetchChatHistory(limit = 10): Promise<Array<{ role: string; content: string }>> {
    try {
      const history = await callGatewayCompat<unknown>(this.api, "chat.history", { limit });
      return Array.isArray(history)
        ? history
            .map(recordValue)
            .filter((item): item is GatewayRecord => Boolean(item))
            .map((item) => ({
              role: textValue(item.role, "unknown"),
              content: textValue(item.content, ""),
            }))
        : [];
    } catch {
      return [];
    }
  }

  async fetchSessions(opts?: {
    limit?: number;
    includeDerivedTitles?: boolean;
    includeLastMessage?: boolean;
    includeGlobal?: boolean;
    includeUnknown?: boolean;
  }): Promise<GatewaySessionInfo[]> {
    try {
      const result = await callGatewayCompat<unknown>(this.api, "sessions.list", {
        limit: opts?.limit ?? 8,
        includeDerivedTitles: opts?.includeDerivedTitles ?? true,
        includeLastMessage: opts?.includeLastMessage ?? false,
        includeGlobal: opts?.includeGlobal ?? true,
        includeUnknown: opts?.includeUnknown ?? true,
      });
      const rows = Array.isArray(recordValue(result)?.sessions)
        ? (recordValue(result)?.sessions as unknown[])
        : Array.isArray(result)
          ? result
          : [];
      return rows
        .map((row) => recordValue(row))
        .filter((row): row is GatewayRecord => Boolean(row))
        .map((row) => ({
          key: textValue(row.key, ""),
          displayName: optionalText(row.displayName ?? row.derivedTitle),
          label: optionalText(row.label),
          updatedAt:
            typeof row.updatedAt === "number" && Number.isFinite(row.updatedAt)
              ? row.updatedAt
              : null,
          hasActiveRun: optionalBoolean(row.hasActiveRun),
          modelProvider: optionalText(row.modelProvider),
          model: optionalText(row.model),
          totalTokens: optionalNumber(row.totalTokens),
          spawnedBy: optionalText(row.spawnedBy),
        }))
        .filter((row) => row.key.length > 0);
    } catch {
      return [];
    }
  }

  async fetchSessionDetail(key: string): Promise<GatewaySessionInfo | null> {
    try {
      const result = await callGatewayCompat<unknown>(this.api, "sessions.describe", {
        key,
        includeDerivedTitles: true,
        includeLastMessage: true,
      });
      const session = recordValue(recordValue(result)?.session);
      if (!session) {
        return null;
      }
      const normalized: GatewaySessionInfo = {
        key: textValue(session.key, key),
        displayName: optionalText(session.displayName ?? session.derivedTitle),
        label: optionalText(session.label),
        updatedAt:
          typeof session.updatedAt === "number" && Number.isFinite(session.updatedAt)
            ? session.updatedAt
            : null,
        hasActiveRun: optionalBoolean(session.hasActiveRun),
        modelProvider: optionalText(session.modelProvider),
        model: optionalText(session.model),
        totalTokens: optionalNumber(session.totalTokens),
        spawnedBy: optionalText(session.spawnedBy),
      };
      return normalized;
    } catch {
      return null;
    }
  }

  async abortSession(key: string): Promise<boolean> {
    try {
      const result = await callGatewayCompat<unknown>(this.api, "sessions.abort", { key });
      const payload = recordValue(result);
      const status = optionalText(payload?.status);
      return status === "aborted" || optionalBoolean(payload?.ok) === true;
    } catch {
      return false;
    }
  }

  async compactSession(key: string, maxLines = 500): Promise<boolean> {
    try {
      const result = await callGatewayCompat<unknown>(this.api, "sessions.compact", {
        key,
        maxLines,
      });
      const payload = recordValue(result);
      const compacted = optionalBoolean(payload?.compacted);
      return compacted === true || optionalBoolean(payload?.ok) === true;
    } catch {
      return false;
    }
  }

  async deleteSession(key: string): Promise<boolean> {
    try {
      const result = await callGatewayCompat<unknown>(this.api, "sessions.delete", {
        key,
      });
      const payload = recordValue(result);
      return optionalBoolean(payload?.deleted) === true || optionalBoolean(payload?.ok) === true;
    } catch {
      return false;
    }
  }

  async sendChatAbort(): Promise<void> {
    await callGatewayCompat(this.api, "chat.abort", {});
  }

  async tailLogsWithStatus(opts?: {
    limit?: number;
    level?: string;
  }): Promise<GatewayTailLogsResult> {
    try {
      const result = await callGatewayCompat<unknown>(this.api, "logs.tail", {
        limit: opts?.limit ?? 20,
        ...(opts?.level ? { level: opts.level } : {}),
      });
      const rows = Array.isArray(result)
        ? result
        : Array.isArray(recordValue(result)?.logs)
          ? (recordValue(result)?.logs as unknown[])
          : [];
      const logs = rows
        .map((row) => recordValue(row))
        .filter((row): row is GatewayRecord => Boolean(row))
        .map((row) => ({
          ts: numberValue(row.ts ?? row.timestamp, Date.now()),
          level: textValue(row.level, "info"),
          message: textValue(row.message ?? row.msg, ""),
        }));
      return { ok: true, logs };
    } catch (err: unknown) {
      return {
        ok: false,
        logs: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async tailLogs(opts?: { limit?: number; level?: string }): Promise<GatewayTailLogEntry[]> {
    const result = await this.tailLogsWithStatus(opts);
    return result.logs;
  }

  async diagStability(): Promise<Record<string, unknown>> {
    try {
      const result = await callGatewayCompat<unknown>(this.api, "diagnostics.stability");
      return recordValue(result) ?? {};
    } catch {
      return {};
    }
  }

  async fetchToolsCatalog(): Promise<string[]> {
    try {
      const tools = await callGatewayCompat<unknown[]>(this.api, "tools.catalog");
      return tools.map((t) => {
        const tool = recordValue(t);
        return tool ? textValue(tool.name ?? tool.id, "unknown") : textValue(t, "unknown");
      });
    } catch {
      return [];
    }
  }

  async fetchChannelStatus(): Promise<Record<string, string>> {
    try {
      const status = await callGatewayCompat<unknown>(this.api, "channels.status");
      const record = recordValue(status);
      if (!record) {
        return {};
      }
      return Object.fromEntries(
        Object.entries(record).map(([key, value]) => [key, textValue(value, "")]),
      );
    } catch {
      return {};
    }
  }

  // ── Cron 執行歷史 ─────────────────────────────────────────────

  async fetchCronRuns(opts?: {
    scope?: "all" | "job";
    limit?: number;
    status?: string;
  }): Promise<
    Array<{ jobId: string; status: string; summary?: string; ts: number; durationMs?: number }>
  > {
    try {
      const result = await callGatewayCompat<unknown>(this.api, "cron.runs", {
        scope: opts?.scope ?? "all",
        limit: opts?.limit ?? 50,
        ...(opts?.status ? { status: opts.status } : {}),
      });
      const record = recordValue(result);
      const runs: unknown[] = Array.isArray(record?.runs)
        ? record.runs
        : Array.isArray(result)
          ? (result as unknown[])
          : [];
      return runs.map((r) => {
        const run = recordValue(r);
        return {
          jobId: textValue(run?.jobId, "unknown"),
          status: textValue(run?.status, "unknown"),
          summary: optionalText(run?.summary),
          ts: typeof run?.ts === "number" ? run.ts : 0,
          durationMs: optionalNumber(run?.durationMs),
        };
      });
    } catch {
      return [];
    }
  }

  // ── Cron 建立 ─────────────────────────────────────────────────

  async createCronJob(params: {
    name: string;
    schedule: { kind: "cron"; expr: string; tz?: string };
    payload: { kind: "agentTurn"; message: string; lightContext?: boolean };
    delivery?: { mode: "announce"; channel?: string };
    enabled?: boolean;
  }): Promise<{ id?: string; ok: boolean; error?: string }> {
    try {
      // sessionTarget 規則：
      //   "main"     → payload.kind 必須是 "systemEvent"
      //   "isolated" → payload.kind 必須是 "agentTurn"
      const sessionTarget = params.payload.kind === "agentTurn" ? "isolated" : "main";
      const result = await callGatewayCompat<unknown>(this.api, "cron.add", {
        name: params.name,
        enabled: params.enabled ?? true,
        schedule: params.schedule,
        sessionTarget,
        wakeMode: "now",
        payload: params.payload,
        delivery: params.delivery ?? { mode: "announce", channel: "telegram" },
      });
      const record = recordValue(result);
      return { id: optionalText(record?.id), ok: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[gateway-rpc] cron.add 失敗:", message);
      return { ok: false, error: message };
    }
  }
}

let gatewayRpcInstance: GatewayRPC | null = null;

export function getGatewayRPC(api: OpenClawPluginApi): GatewayRPC {
  if (!gatewayRpcInstance) {
    gatewayRpcInstance = new GatewayRPC(api);
  }
  return gatewayRpcInstance;
}

/** Reset the singleton (hot-reload / tests). */
export function resetGatewayRPC(): void {
  gatewayRpcInstance = null;
  if (loopbackClient) {
    loopbackClient.destroy();
    loopbackClient = null;
  }
}

function recordValue(value: unknown): GatewayRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as GatewayRecord)
    : undefined;
}

function textValue(value: unknown, fallback: string): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}
