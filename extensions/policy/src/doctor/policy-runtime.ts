import { basename, isAbsolute, resolve } from "node:path";
import JSON5 from "json5";
import { readExecApprovalsSnapshot } from "openclaw/plugin-sdk/exec-approvals-runtime";
import type { HealthCheckContext, HealthFinding } from "openclaw/plugin-sdk/health";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { EXEC_APPROVALS_POLICY_DOCUMENT_NAME } from "../exec-approvals-uri.js";
import type { PolicyAuthProfileEvidence } from "../policy-state.js";
import { CHECK_IDS } from "./check-ids.js";
import {
  SUPPORTED_AUTH_PROFILE_METADATA,
  SUPPORTED_AUTH_PROFILE_MODES,
} from "./policy-constants.js";
import { isChannelDenyRule } from "./shape-helpers.js";
import { readPolicyStringArray } from "./utils.js";

export async function readPolicyFile(
  ctx: HealthCheckContext,
): Promise<{ raw: string; path: string; displayName: string; ocDocName: string } | null> {
  const displayName = policyDisplayName(ctx);
  const file = await readWorkspaceFile(ctx, policyPathSetting(ctx));
  return file === null ? null : { ...file, displayName, ocDocName: basename(displayName) };
}

export async function readExecApprovalsFile() {
  const snapshot = readExecApprovalsSnapshot();
  if (!snapshot.exists || snapshot.raw === null) {
    return null;
  }
  return {
    raw: snapshot.raw,
    path: snapshot.path,
    displayName: snapshot.path,
    ocDocName: EXEC_APPROVALS_POLICY_DOCUMENT_NAME,
  };
}

export async function readWorkspaceFile(
  ctx: HealthCheckContext,
  fileName: string,
): Promise<{ raw: string; path: string } | null> {
  const path = resolveWorkspacePath(ctx, fileName);
  try {
    const fs = await import("node:fs/promises");
    return { raw: await fs.readFile(path, "utf-8"), path };
  } catch (err) {
    if (isNotFoundPathError(err)) {
      return null;
    }
    throw err;
  }
}

function resolveWorkspacePath(ctx: HealthCheckContext, fileName: string): string {
  if (isAbsolute(fileName)) {
    return fileName;
  }
  return resolve(ctx.cwd ?? process.cwd(), fileName);
}

function isNotFoundPathError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

export function parsePolicyFile(
  raw: string,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string } {
  try {
    return { ok: true, value: JSON5.parse(raw) };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export function workspaceRepairsEnabled(ctx: HealthCheckContext): boolean {
  return policySettings(ctx).workspaceRepairs === true;
}

export function readChannelDenyRules(policy: unknown, policyDocName: string) {
  if (
    !isRecord(policy) ||
    !isRecord(policy.channels) ||
    !Array.isArray(policy.channels.denyRules)
  ) {
    return [];
  }
  return policy.channels.denyRules.flatMap((rule, index) =>
    isChannelDenyRule(rule)
      ? [
          {
            when: rule.when,
            requirement: `oc://${policyDocName}/channels/denyRules/#${index}`,
            ...(rule.id === undefined ? {} : { id: rule.id }),
            ...(rule.reason === undefined ? {} : { reason: rule.reason }),
          },
        ]
      : [],
  );
}

export function channelIdsFromFindings(findings: readonly HealthFinding[]): readonly string[] {
  return [
    ...new Set(
      findings
        .filter((finding) => finding.checkId === CHECK_IDS.policyDeniedChannelProvider)
        .map((finding) => finding.ocPath?.match(/^oc:\/\/openclaw\.config\/channels\/(.+)$/)?.[1])
        .filter((id): id is string => id !== undefined && id !== ""),
    ),
  ];
}

export function disableChannels(
  cfg: HealthCheckContext["cfg"],
  channelIds: readonly string[],
): { readonly config: HealthCheckContext["cfg"]; readonly changed: readonly string[] } {
  if (!isRecord(cfg.channels)) {
    return { config: cfg, changed: [] };
  }
  const channels: Record<string, unknown> = { ...cfg.channels };
  const changed: string[] = [];
  for (const id of channelIds) {
    const current = channels[id];
    if (!isRecord(current) || current.enabled === false) {
      continue;
    }
    channels[id] = { ...current, enabled: false };
    changed.push(id);
  }
  if (changed.length === 0) {
    return { config: cfg, changed };
  }
  return { config: { ...cfg, channels }, changed };
}

export type PolicySettings = {
  readonly enabled?: boolean;
  readonly workspaceRepairs?: boolean;
  readonly expectedHash?: string;
  readonly expectedAttestationHash?: string;
  readonly path?: string;
};

export function policySettings(ctx: HealthCheckContext): PolicySettings {
  const pluginConfig = ctx.cfg.plugins?.entries?.["policy"]?.config;
  if (!isRecord(pluginConfig)) {
    return {};
  }
  return pluginConfig;
}

export function policyChecksEnabled(ctx: HealthCheckContext, settings: PolicySettings): boolean {
  const entry = ctx.cfg.plugins?.entries?.["policy"];
  if (!isRecord(entry) || entry.enabled === false) {
    return false;
  }
  return settings.enabled !== false;
}

export function requiredToolMetadata(policy: unknown): ReadonlySet<string> {
  return new Set(readPolicyStringArray(policy, ["tools", "requireMetadata"]) ?? []);
}

export function requiredAuthProfileMetadata(
  policy: unknown,
): ReadonlySet<(typeof SUPPORTED_AUTH_PROFILE_METADATA)[number]> {
  const entries = readPolicyStringArray(policy, ["auth", "profiles", "requireMetadata"]) ?? [];
  return new Set(
    entries.filter((entry): entry is (typeof SUPPORTED_AUTH_PROFILE_METADATA)[number] =>
      SUPPORTED_AUTH_PROFILE_METADATA.some((metadata) => metadata === entry),
    ),
  );
}

export function authProfileHasMetadata(
  profile: PolicyAuthProfileEvidence,
  metadata: (typeof SUPPORTED_AUTH_PROFILE_METADATA)[number],
): boolean {
  if (metadata === "provider") {
    return profile.provider !== undefined && profile.provider.trim() !== "";
  }
  return SUPPORTED_AUTH_PROFILE_MODES.some((mode) => mode === profile.mode);
}

function policyPathSetting(ctx: HealthCheckContext): string {
  const configured = policySettings(ctx).path;
  return typeof configured === "string" && configured.trim() !== ""
    ? configured.trim()
    : "policy.jsonc";
}

export function policyDisplayName(ctx: HealthCheckContext): string {
  const configured = policyPathSetting(ctx);
  return isAbsolute(configured) ? basename(configured) : configured;
}
