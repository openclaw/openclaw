import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { MemoryWikiImportedSourceSyncResult } from "./source-sync.js";
import type { MemoryWikiDoctorReport, MemoryWikiStatus } from "./status.js";

const WIKI_GATEWAY_TIMEOUT_MS = "30000";
const GATEWAY_RESPONSE_MAX_ARRAY_ITEMS = 10_000;
const GATEWAY_RESPONSE_MAX_STRING_CHARS = 10_000;
const GATEWAY_RESPONSE_MAX_CODE_CHARS = 256;

function isBoundedGatewayString(
  value: unknown,
  maxChars = GATEWAY_RESPONSE_MAX_STRING_CHARS,
): value is string {
  return typeof value === "string" && value.length <= maxChars;
}

function isBoundedGatewayStringArray(
  value: unknown,
  maxChars = GATEWAY_RESPONSE_MAX_STRING_CHARS,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= GATEWAY_RESPONSE_MAX_ARRAY_ITEMS &&
    value.every((item) => isBoundedGatewayString(item, maxChars))
  );
}

function hasNumberFields(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => typeof value[key] === "number");
}

function isWarningList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= GATEWAY_RESPONSE_MAX_ARRAY_ITEMS &&
    value.every(
      (item) =>
        isRecord(item) &&
        isBoundedGatewayString(item.code, GATEWAY_RESPONSE_MAX_CODE_CHARS) &&
        isBoundedGatewayString(item.message),
    )
  );
}

function isMemoryWikiStatus(value: unknown): value is MemoryWikiStatus {
  if (!isRecord(value)) {
    return false;
  }
  const bridge = value.bridge;
  const obsidianCli = value.obsidianCli;
  const unsafeLocal = value.unsafeLocal;
  const pageCounts = value.pageCounts;
  const sourceCounts = value.sourceCounts;
  return (
    isBoundedGatewayString(value.vaultScope, GATEWAY_RESPONSE_MAX_CODE_CHARS) &&
    (isBoundedGatewayString(value.agentId, GATEWAY_RESPONSE_MAX_CODE_CHARS) ||
      value.agentId === null) &&
    isBoundedGatewayString(value.vaultMode, GATEWAY_RESPONSE_MAX_CODE_CHARS) &&
    isBoundedGatewayString(value.renderMode, GATEWAY_RESPONSE_MAX_CODE_CHARS) &&
    isBoundedGatewayString(value.vaultPath) &&
    typeof value.vaultExists === "boolean" &&
    (typeof value.bridgePublicArtifactCount === "number" ||
      value.bridgePublicArtifactCount === null) &&
    isRecord(bridge) &&
    typeof bridge.enabled === "boolean" &&
    isRecord(obsidianCli) &&
    typeof obsidianCli.enabled === "boolean" &&
    typeof obsidianCli.requested === "boolean" &&
    typeof obsidianCli.available === "boolean" &&
    (isBoundedGatewayString(obsidianCli.command) || obsidianCli.command === null) &&
    isRecord(unsafeLocal) &&
    typeof unsafeLocal.allowPrivateMemoryCoreAccess === "boolean" &&
    typeof unsafeLocal.pathCount === "number" &&
    isRecord(pageCounts) &&
    hasNumberFields(pageCounts, ["source", "entity", "concept", "synthesis", "report"]) &&
    isRecord(sourceCounts) &&
    hasNumberFields(sourceCounts, ["native", "bridge", "bridgeEvents", "unsafeLocal", "other"]) &&
    isWarningList(value.warnings)
  );
}

function isMemoryWikiDoctorReport(value: unknown): value is MemoryWikiDoctorReport {
  return (
    isRecord(value) &&
    typeof value.healthy === "boolean" &&
    typeof value.warningCount === "number" &&
    isMemoryWikiStatus(value.status) &&
    isWarningList(value.fixes)
  );
}

function isMemoryWikiImportResult(value: unknown): value is MemoryWikiImportedSourceSyncResult {
  return (
    isRecord(value) &&
    hasNumberFields(value, [
      "importedCount",
      "updatedCount",
      "skippedCount",
      "removedCount",
      "artifactCount",
      "workspaces",
    ]) &&
    isBoundedGatewayStringArray(value.pagePaths) &&
    typeof value.indexesRefreshed === "boolean" &&
    isBoundedGatewayStringArray(value.indexUpdatedFiles) &&
    isBoundedGatewayString(value.indexRefreshReason, GATEWAY_RESPONSE_MAX_CODE_CHARS)
  );
}

export async function callWikiGateway(
  method: "wiki.status",
  agentId?: string,
  signal?: AbortSignal,
): Promise<MemoryWikiStatus>;
export async function callWikiGateway(
  method: "wiki.doctor",
  agentId?: string,
  signal?: AbortSignal,
): Promise<MemoryWikiDoctorReport>;
export async function callWikiGateway(
  method: "wiki.bridge.import",
  agentId?: string,
  signal?: AbortSignal,
): Promise<MemoryWikiImportedSourceSyncResult>;
export async function callWikiGateway(
  method: "wiki.status" | "wiki.doctor" | "wiki.bridge.import",
  agentId?: string,
  signal?: AbortSignal,
) {
  const result = await callGatewayFromCli(
    method,
    { timeout: WIKI_GATEWAY_TIMEOUT_MS },
    agentId ? { agentId } : undefined,
    { progress: false, ...(signal ? { signal } : {}) },
  );
  if (
    (method === "wiki.status" && isMemoryWikiStatus(result)) ||
    (method === "wiki.doctor" && isMemoryWikiDoctorReport(result)) ||
    (method === "wiki.bridge.import" && isMemoryWikiImportResult(result))
  ) {
    return result;
  }
  throw new Error(`Invalid Gateway response for ${method}.`);
}
