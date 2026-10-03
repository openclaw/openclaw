import path from "node:path";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import {
  loadSqliteTrajectoryRuntimeEvents,
  type SqliteTrajectoryRuntimeEventForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { readRawQaSessionStore } from "./suite-runtime-agent-session.js";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";

type QaToolSearchDiscoveryReceipt = {
  searchCallId: string;
  searchCallExecution: string;
  searchCallStatus?: string;
  searchOutputExecution: string;
  searchOutputStatus: string;
  discoveredNamespace: string;
  discoveredTool: string;
  targetCallId: string;
  targetNamespace: string;
  targetTool: string;
  targetSuccess: boolean;
};

export function needsSearchEvidence(
  env: Pick<QaSuiteRuntimeEnv, "runtimeId" | "runtimeSelection">,
  capabilityLayer: string | undefined,
): boolean {
  return (
    env.runtimeId === "codex" &&
    env.runtimeSelection === "configured" &&
    capabilityLayer === "openclaw-dynamic-searchable"
  );
}

function readToolSearchDiscoveryReceipt(
  event: SqliteTrajectoryRuntimeEventForTest,
): QaToolSearchDiscoveryReceipt | undefined {
  if (event.type !== "tool.search.discovery" || !isRecord(event.data)) {
    return undefined;
  }
  const search = isRecord(event.data.search) ? event.data.search : undefined;
  const target = isRecord(event.data.target) ? event.data.target : undefined;
  if (!search || !target || !Array.isArray(search.tools)) {
    return undefined;
  }
  const searchCallId = normalizeOptionalString(search.callId);
  const searchCallExecution = normalizeOptionalString(search.callExecution);
  const searchCallStatus = normalizeOptionalString(search.callStatus);
  const searchOutputExecution = normalizeOptionalString(search.outputExecution);
  const searchOutputStatus = normalizeOptionalString(search.outputStatus);
  const targetCallId = typeof target.callId === "string" ? target.callId : undefined;
  const targetNamespace = normalizeOptionalString(target.namespace);
  const targetTool = normalizeOptionalString(target.name);
  if (
    !searchCallId ||
    !searchCallExecution ||
    !searchOutputExecution ||
    !searchOutputStatus ||
    !targetCallId?.trim() ||
    !targetNamespace ||
    !targetTool ||
    typeof target.success !== "boolean"
  ) {
    return undefined;
  }
  const discovered = search.tools.find(
    (tool) =>
      isRecord(tool) &&
      normalizeOptionalString(tool.namespace) === targetNamespace &&
      normalizeOptionalString(tool.name) === targetTool,
  );
  if (!isRecord(discovered)) {
    return undefined;
  }
  const discoveredNamespace = normalizeOptionalString(discovered.namespace);
  const discoveredTool = normalizeOptionalString(discovered.name);
  if (!discoveredNamespace || !discoveredTool) {
    return undefined;
  }
  return {
    searchCallId,
    searchCallExecution,
    ...(searchCallStatus ? { searchCallStatus } : {}),
    searchOutputExecution,
    searchOutputStatus,
    discoveredNamespace,
    discoveredTool,
    targetCallId,
    targetNamespace,
    targetTool,
    targetSuccess: target.success,
  };
}

export function formatToolSearchDiscoveryReceipt(
  phase: string,
  receipt: QaToolSearchDiscoveryReceipt,
): string {
  return [
    `phase=${phase}`,
    `search=${receipt.searchCallId}`,
    `search-call=${receipt.searchCallExecution}${receipt.searchCallStatus ? `/${receipt.searchCallStatus}` : ""}`,
    `search-output=${receipt.searchOutputExecution}/${receipt.searchOutputStatus}`,
    `discovered=${receipt.discoveredNamespace}.${receipt.discoveredTool}`,
    `target=${receipt.targetNamespace}.${receipt.targetTool}#${receipt.targetCallId}`,
    `success=${receipt.targetSuccess}`,
  ].join(" ");
}

export async function requireToolSearchDiscoveryEvidence(
  env: Pick<QaSuiteRuntimeEnv, "gateway">,
  params: {
    sessionKey: string;
    toolName: string;
    expectedCallId: string | undefined;
    expectedSuccess: boolean;
    phase?: string;
  },
): Promise<QaToolSearchDiscoveryReceipt> {
  const normalizedSessionKey = params.sessionKey.trim();
  const normalizedToolName = params.toolName.trim();
  const phase = params.phase ?? (params.expectedSuccess ? "happy-path" : "failure-path");
  if (!normalizedSessionKey || !normalizedToolName || !params.expectedCallId?.trim()) {
    throw new Error(
      "tool_search discovery evidence requires a session key, tool name, and call ID",
    );
  }
  const sessionStore = await readRawQaSessionStore(env);
  const sessionId = normalizeOptionalString(sessionStore[normalizedSessionKey]?.sessionId);
  if (!sessionId) {
    throw new Error(`session entry not found for tool_search discovery: ${normalizedSessionKey}`);
  }
  const runtimeEnv = {
    ...process.env,
    OPENCLAW_STATE_DIR: path.join(env.gateway.tempRoot, "state"),
  };
  const storePath = resolveStorePath(undefined, { agentId: "qa", env: runtimeEnv });
  const events = await loadSqliteTrajectoryRuntimeEvents({
    agentId: "qa",
    env: runtimeEnv,
    sessionId,
    storePath,
  });
  const receipt = events
    .map(readToolSearchDiscoveryReceipt)
    .filter((candidate): candidate is QaToolSearchDiscoveryReceipt => candidate !== undefined)
    .toReversed()
    .find(
      (candidate) =>
        candidate.targetCallId === params.expectedCallId &&
        candidate.targetNamespace === "openclaw" &&
        candidate.targetTool === normalizedToolName &&
        candidate.discoveredNamespace === "openclaw" &&
        candidate.discoveredTool === normalizedToolName &&
        candidate.targetSuccess === params.expectedSuccess,
    );
  if (!receipt) {
    throw new Error(`expected live ${phase} tool_search discovery for ${normalizedToolName}`);
  }
  return receipt;
}

export async function requireRuntimeToolSearchDiscoveryDetails(
  env: Pick<QaSuiteRuntimeEnv, "gateway">,
  params: {
    sessionKeys: readonly [string, string];
    callIds: readonly [string | undefined, string | undefined];
    toolName: string;
  },
): Promise<string[]> {
  const happy = await requireToolSearchDiscoveryEvidence(env, {
    sessionKey: params.sessionKeys[0],
    toolName: params.toolName,
    expectedCallId: params.callIds[0],
    expectedSuccess: true,
  });
  const failure = await requireToolSearchDiscoveryEvidence(env, {
    sessionKey: params.sessionKeys[1],
    toolName: params.toolName,
    expectedCallId: params.callIds[1],
    expectedSuccess: false,
  });
  return [
    `${params.toolName} live provider discovery receipts: happy=${happy.searchCallId} failure=${failure.searchCallId}`,
    `${params.toolName} tool_search discovery ${formatToolSearchDiscoveryReceipt("happy", happy)}`,
    `${params.toolName} tool_search discovery ${formatToolSearchDiscoveryReceipt("failure", failure)}`,
  ];
}
