import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  resolveConfiguredAgentkitPluginConfig,
  type AgentkitHitlMode,
  type AgentkitPluginConfig,
} from "./config.js";

export type AgentkitHitlGrantDecision = "allow-once" | "allow-always";

export type AgentkitHitlGrantScope = {
  toolName: string;
  sessionKey: string | null;
  agentId: string | null;
};

export type AgentkitHitlGrantRecord = {
  id: string;
  approvalMode: AgentkitHitlMode;
  resourceUrl: string | null;
  decision: AgentkitHitlGrantDecision;
  scope: AgentkitHitlGrantScope;
  humanLookupMode: string | null;
  signerAddress: string | null;
  proofNullifier: string | null;
  grantedAtMs: number;
  expiresAtMs: number | null;
  consumedAtMs: number | null;
};

type AgentkitHitlGrantFile = {
  version: 1;
  grants: AgentkitHitlGrantRecord[];
};

export type AgentkitHitlGrantMatch = {
  grant: AgentkitHitlGrantRecord;
  consumed: boolean;
};

const DEFAULT_GRANTS_FILE = path.join(os.homedir(), ".openclaw", "agentkit-hitl-grants.json");

type AgentkitHitlGrantProofContext = {
  approvalMode: AgentkitHitlMode;
  resourceUrl: string | null;
};

function normalizeScope(scope: AgentkitHitlGrantScope): AgentkitHitlGrantScope {
  return {
    toolName: scope.toolName.trim(),
    sessionKey: normalizeOptionalString(scope.sessionKey) ?? null,
    agentId: normalizeOptionalString(scope.agentId) ?? null,
  };
}

function readGrantFile(filePath: string): AgentkitHitlGrantFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { version: 1, grants: [] };
    }
    const version = (parsed as { version?: unknown }).version;
    const grants = (parsed as { grants?: unknown }).grants;
    if (version !== 1 || !Array.isArray(grants)) {
      return { version: 1, grants: [] };
    }
    return {
      version: 1,
      grants: grants.flatMap((entry): AgentkitHitlGrantRecord[] => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          return [];
        }
        const record = entry as Partial<AgentkitHitlGrantRecord>;
        if (
          typeof record.id !== "string" ||
          (record.resourceUrl != null && typeof record.resourceUrl !== "string") ||
          (record.decision !== "allow-once" && record.decision !== "allow-always") ||
          !record.scope ||
          typeof record.scope.toolName !== "string"
        ) {
          return [];
        }
        return [
          {
            id: record.id,
            approvalMode:
              record.approvalMode === "human-approval" ? "human-approval" : "delegation",
            resourceUrl: record.resourceUrl ?? null,
            decision: record.decision,
            scope: record.scope,
            humanLookupMode:
              typeof record.humanLookupMode === "string" ? record.humanLookupMode : null,
            signerAddress: typeof record.signerAddress === "string" ? record.signerAddress : null,
            proofNullifier:
              typeof record.proofNullifier === "string" ? record.proofNullifier : null,
            grantedAtMs: typeof record.grantedAtMs === "number" ? record.grantedAtMs : 0,
            expiresAtMs: typeof record.expiresAtMs === "number" ? record.expiresAtMs : null,
            consumedAtMs: typeof record.consumedAtMs === "number" ? record.consumedAtMs : null,
          },
        ];
      }),
    };
  } catch {
    return { version: 1, grants: [] };
  }
}

function writeGrantFile(filePath: string, file: AgentkitHitlGrantFile): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(file, null, 2) + "\n", "utf8");
}

function isGrantExpired(grant: AgentkitHitlGrantRecord, nowMs: number): boolean {
  return grant.expiresAtMs != null && grant.expiresAtMs <= nowMs;
}

function normalizeGrantResourceUrl(resourceUrl: string | null | undefined): string | null {
  return normalizeOptionalString(resourceUrl) ?? null;
}

function resolveRequestedProofContext(
  pluginConfig: AgentkitPluginConfig,
): AgentkitHitlGrantProofContext {
  return {
    approvalMode: pluginConfig.hitl.mode,
    resourceUrl:
      pluginConfig.hitl.mode === "delegation"
        ? normalizeGrantResourceUrl(pluginConfig.hitl.resourceUrl)
        : null,
  };
}

function proofContextMatches(
  grant: AgentkitHitlGrantRecord,
  requested: AgentkitHitlGrantProofContext,
): boolean {
  return (
    grant.approvalMode === requested.approvalMode &&
    normalizeGrantResourceUrl(grant.resourceUrl) === requested.resourceUrl
  );
}

function scopeMatches(
  candidate: AgentkitHitlGrantScope,
  requested: AgentkitHitlGrantScope,
  grantScope: AgentkitPluginConfig["hitl"]["grantScope"],
): boolean {
  if (candidate.toolName !== requested.toolName) {
    return false;
  }
  if (grantScope === "agent") {
    return candidate.agentId != null && candidate.agentId === requested.agentId;
  }
  return candidate.sessionKey != null && candidate.sessionKey === requested.sessionKey;
}

export function resolveAgentkitHitlGrantsFilePath(params: {
  appConfig?: OpenClawConfig;
  pluginConfig?: AgentkitPluginConfig;
}): string {
  const pluginConfig =
    params.pluginConfig ??
    (params.appConfig ? resolveConfiguredAgentkitPluginConfig(params.appConfig) : undefined);
  return pluginConfig?.hitl.grantsFile ?? DEFAULT_GRANTS_FILE;
}

export function loadAgentkitHitlGrants(params: {
  appConfig?: OpenClawConfig;
  pluginConfig?: AgentkitPluginConfig;
}): AgentkitHitlGrantRecord[] {
  return readGrantFile(resolveAgentkitHitlGrantsFilePath(params)).grants;
}

export function saveAgentkitHitlGrant(params: {
  appConfig?: OpenClawConfig;
  pluginConfig?: AgentkitPluginConfig;
  grant: AgentkitHitlGrantRecord;
}): void {
  const filePath = resolveAgentkitHitlGrantsFilePath(params);
  const file = readGrantFile(filePath);
  file.grants = [...file.grants.filter((entry) => entry.id !== params.grant.id), params.grant];
  writeGrantFile(filePath, file);
}

export function findMatchingAgentkitHitlGrant(params: {
  appConfig?: OpenClawConfig;
  pluginConfig: AgentkitPluginConfig;
  scope: AgentkitHitlGrantScope;
  nowMs?: number;
}): AgentkitHitlGrantRecord | null {
  const nowMs = params.nowMs ?? Date.now();
  const requestedScope = normalizeScope(params.scope);
  const requestedProofContext = resolveRequestedProofContext(params.pluginConfig);
  const grants = loadAgentkitHitlGrants({
    appConfig: params.appConfig,
    pluginConfig: params.pluginConfig,
  });
  return (
    grants.find((grant) => {
      if (grant.consumedAtMs != null || isGrantExpired(grant, nowMs)) {
        return false;
      }
      if (!proofContextMatches(grant, requestedProofContext)) {
        return false;
      }
      return scopeMatches(
        normalizeScope(grant.scope),
        requestedScope,
        params.pluginConfig.hitl.grantScope,
      );
    }) ?? null
  );
}

export function applyAgentkitHitlGrant(params: {
  appConfig?: OpenClawConfig;
  pluginConfig: AgentkitPluginConfig;
  scope: AgentkitHitlGrantScope;
  nowMs?: number;
}): AgentkitHitlGrantMatch | null {
  const filePath = resolveAgentkitHitlGrantsFilePath(params);
  const file = readGrantFile(filePath);
  const nowMs = params.nowMs ?? Date.now();
  const requestedScope = normalizeScope(params.scope);
  const requestedProofContext = resolveRequestedProofContext(params.pluginConfig);
  const originalGrantCount = file.grants.length;

  let matched: AgentkitHitlGrantRecord | null = null;
  const retained: AgentkitHitlGrantRecord[] = [];
  for (const grant of file.grants) {
    if (grant.consumedAtMs != null || isGrantExpired(grant, nowMs)) {
      continue;
    }
    if (
      matched == null &&
      proofContextMatches(grant, requestedProofContext) &&
      scopeMatches(normalizeScope(grant.scope), requestedScope, params.pluginConfig.hitl.grantScope)
    ) {
      matched =
        grant.decision === "allow-once"
          ? {
              ...grant,
              consumedAtMs: nowMs,
            }
          : grant;
      if (grant.decision !== "allow-once") {
        retained.push(grant);
      }
      continue;
    }
    retained.push(grant);
  }
  file.grants = retained;

  if (!matched) {
    if (file.grants.length !== originalGrantCount) {
      writeGrantFile(filePath, file);
    }
    return null;
  }

  writeGrantFile(filePath, file);
  const appliedGrant = matched;
  return {
    grant: appliedGrant,
    consumed: appliedGrant.decision === "allow-once",
  };
}
