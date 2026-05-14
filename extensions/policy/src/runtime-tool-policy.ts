import { promises as fs } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import JSON5 from "json5";
import { resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  OpenClawPluginApi,
  PluginJsonValue,
  PluginTrustedToolPolicyRegistration,
} from "openclaw/plugin-sdk/core";
import {
  collectPolicyEvidence,
  policyDocumentHash,
  policyWorkspaceHash,
  type PolicyEvidence,
  type PolicyToolEvidence,
} from "./policy-state.js";

const SUPPORTED_TOOL_METADATA = ["risk", "sensitivity", "owner"] as const;

type PolicyRuntimeSettings = {
  readonly enabled?: boolean;
  readonly runtimeToolPolicy?: boolean;
  readonly expectedHash?: string;
  readonly path?: string;
};

type RuntimePolicyState = {
  readonly policyPath: string;
  readonly policyError?: string;
  readonly policyHash?: string;
  readonly policy?: unknown;
  readonly evidence: PolicyEvidence;
  readonly settings: PolicyRuntimeSettings;
};

type RuntimePolicyDeps = {
  readonly readConfig?: () => OpenClawConfig;
  readonly cwd?: string;
  readonly resolveWorkspaceDir?: (cfg: OpenClawConfig, ctx: PolicyToolContext) => string;
};

type PolicyToolEvent = {
  readonly toolName: string;
  readonly params: Record<string, unknown>;
};

type PolicyToolContext = {
  readonly agentId?: string;
  readonly toolName?: string;
  readonly workspaceDir?: string;
};

type PolicyToolDecision = Awaited<ReturnType<PluginTrustedToolPolicyRegistration["evaluate"]>>;

const POLICY_APPROVAL_DECISIONS: Array<"allow-once" | "deny"> = ["allow-once", "deny"];

export function registerPolicyTrustedToolPolicy(
  api: Pick<OpenClawPluginApi, "config" | "registerTrustedToolPolicy" | "runtime">,
  deps: RuntimePolicyDeps = {},
): void {
  api.registerTrustedToolPolicy({
    id: "policy-tool-runtime",
    description: "Apply enabled policy tool requirements before tool calls.",
    async evaluate(event, ctx) {
      return evaluatePolicyTrustedToolCall(event, ctx, {
        cwd: deps.cwd,
        readConfig:
          deps.readConfig ??
          (() => (api.runtime.config?.current?.() as OpenClawConfig | undefined) ?? api.config),
        resolveWorkspaceDir:
          deps.resolveWorkspaceDir ??
          ((cfg, context) => {
            const agentId = context.agentId ?? resolveDefaultAgentId(cfg);
            return context.workspaceDir ?? api.runtime.agent.resolveAgentWorkspaceDir(cfg, agentId);
          }),
      });
    },
  });
}

export async function evaluatePolicyTrustedToolCall(
  event: PolicyToolEvent,
  ctx: PolicyToolContext,
  deps: RuntimePolicyDeps = {},
): Promise<PolicyToolDecision> {
  const cfg = deps.readConfig?.();
  if (cfg === undefined) {
    return undefined;
  }
  const settings = policySettings(cfg);
  if (!policyExtensionEnabled(cfg)) {
    return undefined;
  }
  if (settings.runtimeToolPolicy !== true) {
    return undefined;
  }

  const workspaceDir = deps.cwd ?? deps.resolveWorkspaceDir?.(cfg, ctx);
  if (workspaceDir === undefined) {
    return undefined;
  }
  const state = await loadRuntimePolicyState(cfg, settings, workspaceDir);

  const expectedHash = state.settings.expectedHash;
  if (state.policyError !== undefined) {
    return {
      block: true,
      blockReason: state.policyError,
    };
  }
  if (state.policy === undefined) {
    return {
      block: true,
      blockReason: `Policy tool runtime is enabled, but ${state.policyPath} is missing.`,
    };
  }
  if (
    typeof expectedHash === "string" &&
    expectedHash.trim() !== "" &&
    state.policyHash !== expectedHash.trim()
  ) {
    return {
      block: true,
      blockReason: `${state.policyPath} does not match the configured policy hash.`,
    };
  }

  const tool = state.evidence.tools.find((entry) => entry.id === event.toolName);
  if (tool === undefined) {
    if (toolMetadataRequired(state)) {
      return {
        requireApproval: {
          title: "Review undeclared tool",
          description: `Policy requires tool metadata, but '${event.toolName}' is not declared in TOOLS.md.`,
          severity: "warning" as const,
          metadata: runtimeApprovalMetadata(state, event.toolName),
          allowedDecisions: [...POLICY_APPROVAL_DECISIONS],
        },
      };
    }
    return undefined;
  }

  const metadataBlockReason = toolMetadataBlockReason(tool, state);
  if (metadataBlockReason !== undefined) {
    return {
      block: true,
      blockReason: metadataBlockReason,
    };
  }

  const approvalReason = toolApprovalReason(tool);
  if (approvalReason === undefined) {
    return undefined;
  }
  return {
    requireApproval: {
      title: "Review policy-governed tool",
      description: `${event.toolName} requires approval because ${approvalReason}.`,
      severity: tool.risk === "critical" ? ("critical" as const) : ("warning" as const),
      metadata: runtimeApprovalMetadata(state, event.toolName, tool),
      allowedDecisions: [...POLICY_APPROVAL_DECISIONS],
    },
  };
}

function runtimeApprovalMetadata(
  state: RuntimePolicyState,
  toolName: string,
  tool?: PolicyToolEvidence,
): PluginJsonValue {
  const expectedHash = state.settings.expectedHash?.trim();
  return {
    source: "policy",
    policy: {
      path: state.policyPath,
      ...(state.policyHash !== undefined ? { hash: state.policyHash } : {}),
      ...(expectedHash ? { expectedHash } : {}),
    },
    workspace: {
      scope: "policy",
      hash: policyWorkspaceHash(state.evidence),
    },
    target: tool?.source ?? `oc://TOOLS.md/tools/${toolName}`,
  };
}

async function loadRuntimePolicyState(
  cfg: OpenClawConfig,
  settings: PolicyRuntimeSettings,
  cwd: string,
): Promise<RuntimePolicyState> {
  const policyPath = policyDisplayName(settings);
  const toolsRaw = await readFileIfExists(resolve(cwd, "TOOLS.md"));
  const evidence = collectPolicyEvidence(
    cfg as Record<string, unknown>,
    toolsRaw === null ? {} : { toolsRaw },
  );
  const policyRaw = await readFileIfExists(resolveWorkspacePath(cwd, policyPathSetting(settings)));
  if (policyRaw === null) {
    return { policyPath, evidence, settings };
  }
  const parsed = parsePolicyFile(policyRaw);
  if (!parsed.ok) {
    return {
      policyPath,
      policyError: `Policy tool runtime is enabled, but ${policyPath} could not be parsed.`,
      evidence,
      settings,
    };
  }
  const policy = parsed.value;
  const policyShapeError = validateRuntimePolicyShape(policy, policyPath);
  if (policyShapeError !== undefined) {
    return { policyPath, policyError: policyShapeError, evidence, settings };
  }
  return {
    policyPath,
    policy,
    policyHash: policyDocumentHash(policy),
    evidence,
    settings,
  };
}

function toolMetadataRequired(state: RuntimePolicyState): boolean {
  return requiredToolMetadata(state.policy).size > 0;
}

function toolMetadataBlockReason(
  tool: PolicyToolEvidence,
  state: RuntimePolicyState,
): string | undefined {
  const required = requiredToolMetadata(state.policy);
  if (required.has("risk") && tool.risk === undefined) {
    return `Policy requires risk metadata for '${tool.id}', but TOOLS.md does not declare it.`;
  }
  if (tool.risk !== undefined && !["low", "medium", "high", "critical"].includes(tool.risk)) {
    return `Policy requires known risk metadata for '${tool.id}', but TOOLS.md declares '${tool.risk}'.`;
  }
  if (required.has("sensitivity")) {
    if (tool.sensitivity === undefined) {
      return `Policy requires sensitivity metadata for '${tool.id}', but TOOLS.md does not declare it.`;
    }
    if (!["public", "internal", "confidential", "restricted"].includes(tool.sensitivity)) {
      return `Policy requires known sensitivity metadata for '${tool.id}', but TOOLS.md declares '${tool.sensitivity}'.`;
    }
  }
  if (required.has("owner") && tool.owner === undefined) {
    return `Policy requires owner metadata for '${tool.id}', but TOOLS.md does not declare it.`;
  }
  return undefined;
}

function validateRuntimePolicyShape(policy: unknown, policyPath: string): string | undefined {
  if (!isRecord(policy)) {
    return `Policy tool runtime is enabled, but ${policyPath} does not contain an object.`;
  }
  if (policy.tools !== undefined && !isRecord(policy.tools)) {
    return `Policy tool runtime is enabled, but ${policyPath} has an invalid tools section.`;
  }
  if (isRecord(policy.tools)) {
    if (
      policy.tools.requireMetadata !== undefined &&
      !isStringArray(policy.tools.requireMetadata)
    ) {
      return `Policy tool runtime is enabled, but ${policyPath} has an invalid tools.requireMetadata section.`;
    }
    const unsupported = unsupportedToolMetadata(policy.tools.requireMetadata);
    if (unsupported !== undefined) {
      return `Policy tool runtime is enabled, but ${policyPath} has unsupported tools.requireMetadata '${unsupported}'.`;
    }
    if (policy.tools.settings !== undefined && !isRecord(policy.tools.settings)) {
      return `Policy tool runtime is enabled, but ${policyPath} has an invalid tools.settings section.`;
    }
    if (policy.tools.entries !== undefined && !Array.isArray(policy.tools.entries)) {
      return `Policy tool runtime is enabled, but ${policyPath} has an invalid tools.entries section.`;
    }
  }
  if (policy.channels !== undefined && !isRecord(policy.channels)) {
    return `Policy tool runtime is enabled, but ${policyPath} has an invalid channels section.`;
  }
  if (
    isRecord(policy.channels) &&
    policy.channels.denyRules !== undefined &&
    !Array.isArray(policy.channels.denyRules)
  ) {
    return `Policy tool runtime is enabled, but ${policyPath} has an invalid channels.denyRules section.`;
  }
  return undefined;
}

function requiredToolMetadata(policy: unknown): ReadonlySet<string> {
  return new Set(readPolicyStringArray(policy, ["tools", "requireMetadata"]) ?? []);
}

function readPolicyStringArray(
  policy: unknown,
  path: readonly string[],
): readonly string[] | undefined {
  let current: unknown = policy;
  for (const part of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[part];
  }
  if (!Array.isArray(current) || !current.every((entry) => typeof entry === "string")) {
    return undefined;
  }
  return current.map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function unsupportedToolMetadata(value: unknown): string | undefined {
  if (!isStringArray(value)) {
    return undefined;
  }
  return value
    .map((entry) => entry.trim().toLowerCase())
    .find(
      (entry) =>
        entry !== "" &&
        !SUPPORTED_TOOL_METADATA.includes(entry as (typeof SUPPORTED_TOOL_METADATA)[number]),
    );
}

function toolApprovalReason(tool: PolicyToolEvidence): string | undefined {
  const reasons: string[] = [];
  if (tool.risk === "critical") {
    reasons.push("risk is critical");
  }
  if (tool.capabilities?.includes("IRREVERSIBLE_EXTERNAL")) {
    reasons.push("it can perform irreversible external actions");
  }
  return reasons.length === 0 ? undefined : reasons.join(" and ");
}

function policySettings(cfg: OpenClawConfig): PolicyRuntimeSettings {
  const pluginConfig = cfg.plugins?.entries?.policy?.config;
  return isRecord(pluginConfig) ? pluginConfig : {};
}

function policyExtensionEnabled(cfg: OpenClawConfig): boolean {
  const entry = cfg.plugins?.entries?.policy;
  const settings = policySettings(cfg);
  if (entry === undefined || entry.enabled === false || settings.enabled === false) {
    return false;
  }
  return entry.enabled === true || settings.enabled === true;
}

function policyPathSetting(settings: PolicyRuntimeSettings): string {
  return typeof settings.path === "string" && settings.path.trim() !== ""
    ? settings.path.trim()
    : "policy.jsonc";
}

function policyDisplayName(settings: PolicyRuntimeSettings): string {
  const configured = policyPathSetting(settings);
  return isAbsolute(configured) ? basename(configured) : configured;
}

function resolveWorkspacePath(cwd: string, fileName: string): string {
  return isAbsolute(fileName) ? fileName : resolve(cwd, fileName);
}

async function readFileIfExists(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, "utf-8");
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

function parsePolicyFile(
  raw: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    return { ok: true, value: JSON5.parse(raw) };
  } catch {
    return { ok: false };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
