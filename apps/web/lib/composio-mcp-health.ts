import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  fetchComposioMcpToolsList,
  resolveComposioApiKey,
  resolveComposioEligibility,
  resolveComposioGatewayUrl,
} from "@/lib/composio";
import { refreshIntegrationsRuntime, type IntegrationRuntimeRefresh } from "@/lib/integrations";
import {
  resolveActiveAgentId,
  resolveOpenClawStateDir,
  resolveWorkspaceRoot,
} from "@/lib/workspace";
import { spawnAgentStartForSession, type AgentEvent } from "@/lib/agent-runner";
import { buildComposioMcpServerConfig } from "../../../src/cli/dench-cloud";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readConfig(): UnknownRecord {
  const configPath = join(resolveOpenClawStateDir(), "openclaw.json");
  if (!existsSync(configPath)) {
    return {};
  }
  try {
    return (JSON.parse(readFileSync(configPath, "utf-8")) as UnknownRecord) ?? {};
  } catch {
    return {};
  }
}

function writeConfig(config: UnknownRecord): void {
  const configPath = join(resolveOpenClawStateDir(), "openclaw.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function ensureRecord(parent: UnknownRecord, key: string): UnknownRecord {
  const existing = asRecord(parent[key]);
  if (existing) {
    return existing;
  }
  const fresh: UnknownRecord = {};
  parent[key] = fresh;
  return fresh;
}

type CheckStatus = "pass" | "fail" | "unknown";
type SummaryLevel = "healthy" | "warning" | "error";

export type ComposioMcpHealthCheck = {
  status: CheckStatus;
  detail: string;
  checkedAt: string;
};

export type ComposioMcpServerSnapshot = {
  url: string | null;
  transport: string | null;
  authorizationHeader: string | null;
};

export type ComposioMcpHealth = {
  generatedAt: string;
  workspaceDir: string | null;
  gatewayUrl: string;
  eligible: boolean;
  lockReason: "missing_dench_key" | "dench_not_primary" | null;
  lockBadge: string | null;
  config: ComposioMcpHealthCheck & {
    matchesExpected: boolean;
    configured: ComposioMcpServerSnapshot;
    expected: ComposioMcpServerSnapshot;
  };
  gatewayTools: ComposioMcpHealthCheck & {
    toolCount: number | null;
  };
  liveAgent: ComposioMcpHealthCheck & {
    visible: boolean | null;
    evidence: string[];
    toolCallsDetected: boolean;
  };
  summary: {
    level: SummaryLevel;
    verified: boolean;
    message: string;
  };
  refresh?: IntegrationRuntimeRefresh;
};

const COMPOSIO_MCP_STATUS_FILE = "composio-mcp-status.json";
const GATEWAY_TOOLS_CACHE_TTL_MS = 5 * 60_000;
const LIVE_AGENT_NOT_CHECKED_DETAIL = "Live agent visibility has not been checked yet.";
const LIVE_AGENT_REPAIR_PENDING_DETAIL = "Configuration repaired. Run live agent verification to confirm MCP visibility.";

const COMPOSIO_LIVE_PROBE_PROMPT = [
  "You are running a Composio MCP availability probe.",
  "Without calling any tool, inspect your currently available tool list.",
  "Reply with exactly one JSON object and nothing else.",
  'Use this schema: {"visible":true|false,"reason":"...","evidence":["..."]}.',
  "Set visible=true only if this session directly exposes a Composio MCP path, meaning you can see either a server named `composio` or tool names like `GMAIL_FETCH_EMAILS`, `SLACK_SEND_MESSAGE`, `GITHUB_FIND_PULL_REQUESTS`, `NOTION_SEARCH`, `GOOGLE_CALENDAR_EVENTS_LIST`, or `LINEAR_LIST_ISSUES` in your available tools.",
  "If you are unsure, set visible=false.",
  "Do not call any tool.",
].join("\n");

function nowIso(): string {
  return new Date().toISOString();
}

function isFresh(checkedAt: string | undefined, ttlMs: number): boolean {
  if (!checkedAt) {
    return false;
  }
  const timestamp = Date.parse(checkedAt);
  return Number.isFinite(timestamp) && Date.now() - timestamp <= ttlMs;
}

function resolveStatusFilePath(workspaceDir: string | null): string | null {
  if (workspaceDir) {
    return join(workspaceDir, COMPOSIO_MCP_STATUS_FILE);
  }
  return join(resolveOpenClawStateDir(), COMPOSIO_MCP_STATUS_FILE);
}

function writeHealthFile(health: ComposioMcpHealth): void {
  const outPath = resolveStatusFilePath(health.workspaceDir);
  if (!outPath) {
    return;
  }
  writeFileSync(outPath, JSON.stringify(health, null, 2) + "\n", "utf-8");
}

function readPersistedHealth(workspaceDir: string | null): ComposioMcpHealth | null {
  const filePath = resolveStatusFilePath(workspaceDir);
  if (!filePath || !existsSync(filePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
    const record = asRecord(parsed);
    return record ? (record as unknown as ComposioMcpHealth) : null;
  } catch {
    return null;
  }
}

function readConfiguredComposioServer(config: UnknownRecord): ComposioMcpServerSnapshot {
  const mcp = asRecord(config.mcp);
  const servers = asRecord(mcp?.servers);
  const composio = asRecord(servers?.composio);
  const headers = asRecord(composio?.headers);
  return {
    url: readString(composio?.url) ?? null,
    transport: readString(composio?.transport) ?? null,
    authorizationHeader: readString(headers?.Authorization) ?? null,
  };
}

function buildExpectedServerSnapshot(gatewayUrl: string, apiKey: string): ComposioMcpServerSnapshot {
  const expected = buildComposioMcpServerConfig(gatewayUrl, apiKey);
  return {
    url: expected.url,
    transport: expected.transport,
    authorizationHeader: expected.headers.Authorization,
  };
}

function compareServerSnapshots(
  configured: ComposioMcpServerSnapshot,
  expected: ComposioMcpServerSnapshot,
): boolean {
  return configured.url === expected.url
    && configured.transport === expected.transport
    && configured.authorizationHeader === expected.authorizationHeader;
}

function parseProbeJson(raw: string): {
  visible: boolean;
  reason: string;
  evidence: string[];
} | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    const record = asRecord(parsed);
    if (!record || typeof record.visible !== "boolean") {
      return null;
    }
    return {
      visible: record.visible,
      reason: readString(record.reason) ?? "Live probe completed.",
      evidence: Array.isArray(record.evidence)
        ? record.evidence.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        : [],
    };
  } catch {
    return null;
  }
}

async function runLiveAgentProbe(): Promise<ComposioMcpHealth["liveAgent"]> {
  const checkedAt = nowIso();
  const sessionKey = `agent:${resolveActiveAgentId()}:probe:composio-mcp-${randomUUID()}`;
  const child = spawnAgentStartForSession(COMPOSIO_LIVE_PROBE_PROMPT, sessionKey);

  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let toolCallsDetected = false;

    const finish = (result: ComposioMcpHealth["liveAgent"]) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({
        status: "unknown",
        detail: "Live agent probe timed out before returning a result.",
        checkedAt,
        visible: null,
        evidence: [],
        toolCallsDetected,
      });
    }, 20_000);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stdout += text;
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          const event = JSON.parse(trimmed) as AgentEvent;
          if (event.event === "agent" && event.stream === "tool") {
            toolCallsDetected = true;
          }
        } catch {
          // ignore malformed lines
        }
      }
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("close", () => {
      const chatPayloads = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as AgentEvent;
          } catch {
            return null;
          }
        })
        .filter((event): event is AgentEvent => Boolean(event));

      const finalChat = [...chatPayloads].reverse().find((event) => {
        if (event.event !== "chat") {
          return false;
        }
        const data = asRecord(event.data);
        const message = asRecord(data?.message);
        return data?.state === "final" && message?.role === "assistant";
      });
      const finalChatText = readString(asRecord(asRecord(finalChat?.data)?.message)?.content);

      const assistantText = chatPayloads
        .filter((event) => event.event === "agent" && event.stream === "assistant")
        .map((event) => readString(asRecord(event.data)?.delta))
        .filter((value): value is string => Boolean(value))
        .join("");

      const parsed = parseProbeJson(finalChatText || assistantText);
      if (!parsed) {
        finish({
          status: "unknown",
          detail: stderr.trim() || "Live agent probe did not return parseable JSON.",
          checkedAt,
          visible: null,
          evidence: [],
          toolCallsDetected,
        });
        return;
      }

      finish({
        status: parsed.visible && !toolCallsDetected ? "pass" : "fail",
        detail: toolCallsDetected
          ? "Probe unexpectedly invoked tools instead of inspecting the live tool list."
          : parsed.reason,
        checkedAt,
        visible: parsed.visible && !toolCallsDetected,
        evidence: parsed.evidence,
        toolCallsDetected,
      });
    });
  });
}

function buildSummary(params: {
  config: ComposioMcpHealth["config"];
  gatewayTools: ComposioMcpHealth["gatewayTools"];
  liveAgent: ComposioMcpHealth["liveAgent"];
  eligible: boolean;
  lockBadge: string | null;
}): ComposioMcpHealth["summary"] {
  if (!params.eligible) {
    return {
      level: "error",
      verified: false,
      message: params.lockBadge
        ? `Composio is locked until ${params.lockBadge.toLowerCase()}.`
        : "Composio is not currently eligible in this workspace.",
    };
  }

  if (params.config.status === "fail") {
    return {
      level: "error",
      verified: false,
      message: "Composio MCP is not registered correctly in openclaw.json.",
    };
  }

  if (params.gatewayTools.status === "fail") {
    return {
      level: "error",
      verified: false,
      message: "Composio MCP is configured, but the gateway tools/list probe failed.",
    };
  }

  if (params.liveAgent.status === "fail") {
    return {
      level: "error",
      verified: false,
      message: "Composio MCP is configured, but a live agent session could not see the tools directly.",
    };
  }

  if (params.liveAgent.status === "pass") {
    return {
      level: "healthy",
      verified: true,
      message: "Composio MCP is configured, reachable, and visible to live agent sessions.",
    };
  }

  return {
    level: "healthy",
    verified: false,
    message: params.liveAgent.detail === LIVE_AGENT_REPAIR_PENDING_DETAIL
      ? "Composio MCP configuration was refreshed and a live-agent verification can run in the background."
      : "Composio MCP is configured and the gateway is reachable. Live-agent verification is pending.",
  };
}

async function applyComposioMcpRepair(
  gatewayUrl: string,
  apiKey: string,
): Promise<IntegrationRuntimeRefresh> {
  const config = readConfig();
  const mcp = ensureRecord(config, "mcp");
  const servers = ensureRecord(mcp, "servers");
  servers.composio = buildComposioMcpServerConfig(gatewayUrl, apiKey);
  writeConfig(config);
  return await refreshIntegrationsRuntime();
}

export async function getComposioMcpHealth(options?: {
  includeLiveAgentProbe?: boolean;
  repairConfig?: boolean;
}): Promise<ComposioMcpHealth> {
  const generatedAt = nowIso();
  const workspaceDir = resolveWorkspaceRoot();
  const gatewayUrl = resolveComposioGatewayUrl();
  const apiKey = resolveComposioApiKey();
  const eligibility = resolveComposioEligibility();
  const persisted = readPersistedHealth(workspaceDir);

  const config = readConfig();
  const configuredServer = readConfiguredComposioServer(config);
  const expectedServer = apiKey
    ? buildExpectedServerSnapshot(gatewayUrl, apiKey)
    : {
        url: null,
        transport: null,
        authorizationHeader: null,
      };

  let refresh: IntegrationRuntimeRefresh | undefined;
  let latestConfiguredServer = configuredServer;
  if (options?.repairConfig && apiKey) {
    refresh = await applyComposioMcpRepair(gatewayUrl, apiKey);
    latestConfiguredServer = readConfiguredComposioServer(readConfig());
  }

  const matchesExpected = apiKey
    ? compareServerSnapshots(latestConfiguredServer, expectedServer)
    : false;

  const configCheck: ComposioMcpHealth["config"] = {
    status: apiKey
      ? (matchesExpected ? "pass" : "fail")
      : "unknown",
    detail: !apiKey
      ? "No Dench Cloud API key is configured."
      : matchesExpected
        ? "The Composio MCP server matches the expected gateway URL, transport, and Authorization header."
        : "The Composio MCP server is missing or does not match the expected Dench Cloud gateway configuration.",
    checkedAt: generatedAt,
    matchesExpected,
    configured: latestConfiguredServer,
    expected: expectedServer,
  };

  let gatewayTools: ComposioMcpHealth["gatewayTools"] = {
    status: "unknown",
    detail: "Gateway tools/list probe was skipped.",
    checkedAt: generatedAt,
    toolCount: null,
  };

  if (apiKey) {
    const persistedGatewayTools = persisted?.gatewayTools;
    if (
      persistedGatewayTools
      && !options?.repairConfig
      && isFresh(persistedGatewayTools.checkedAt, GATEWAY_TOOLS_CACHE_TTL_MS)
    ) {
      gatewayTools = persistedGatewayTools;
    } else {
      try {
        const tools = await fetchComposioMcpToolsList(gatewayUrl, apiKey);
        gatewayTools = {
          status: tools.length > 0 ? "pass" : "fail",
          detail: tools.length > 0
            ? "The gateway returned Composio MCP tools successfully."
            : "The gateway returned zero Composio MCP tools.",
          checkedAt: generatedAt,
          toolCount: tools.length,
        };
      } catch (error) {
        gatewayTools = {
          status: "fail",
          detail: error instanceof Error ? error.message : "The gateway tools/list probe failed.",
          checkedAt: generatedAt,
          toolCount: null,
        };
      }
    }
  }

  let liveAgent: ComposioMcpHealth["liveAgent"] = persisted?.liveAgent ?? {
    status: "unknown",
    detail: LIVE_AGENT_NOT_CHECKED_DETAIL,
    checkedAt: generatedAt,
    visible: null,
    evidence: [],
    toolCallsDetected: false,
  };

  if (options?.includeLiveAgentProbe && apiKey) {
    liveAgent = await runLiveAgentProbe();
  } else if (options?.repairConfig) {
    liveAgent = {
      status: "unknown",
      detail: LIVE_AGENT_REPAIR_PENDING_DETAIL,
      checkedAt: generatedAt,
      visible: null,
      evidence: [],
      toolCallsDetected: false,
    };
  } else if (!persisted) {
    liveAgent = {
      ...liveAgent,
      checkedAt: generatedAt,
    };
  }

  const summary = buildSummary({
    config: configCheck,
    gatewayTools,
    liveAgent,
    eligible: eligibility.eligible,
    lockBadge: eligibility.lockBadge,
  });

  const health: ComposioMcpHealth = {
    generatedAt,
    workspaceDir,
    gatewayUrl,
    eligible: eligibility.eligible,
    lockReason: eligibility.lockReason,
    lockBadge: eligibility.lockBadge,
    config: configCheck,
    gatewayTools,
    liveAgent,
    summary,
    ...(refresh ? { refresh } : {}),
  };

  writeHealthFile(health);
  return health;
}
