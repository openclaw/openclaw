import { basename, isAbsolute, resolve } from "node:path";
import {
  parseOcDocument,
  parseOcPath,
  resolveOcPath,
  type Diagnostic,
  type JsoncAst,
} from "@openclaw/oc-path/api.js";
import {
  registerHealthCheck,
  type HealthCheck,
  type HealthCheckContext,
  type HealthFinding,
} from "openclaw/plugin-sdk/health";
import { jsoncValueToUnknown } from "../jsonc-value.js";
import { collectPolicyEvidence, policyDocumentHash, type PolicyEvidence } from "../policy-state.js";

const CHECK_IDS = {
  policyDeniedChannelProvider: "policy/channels-denied-provider",
  policyHashMismatch: "policy/policy-hash-mismatch",
  policyMissingFile: "policy/policy-jsonc-missing",
} as const;

export const POLICY_CHECK_IDS = [
  CHECK_IDS.policyMissingFile,
  CHECK_IDS.policyHashMismatch,
  CHECK_IDS.policyDeniedChannelProvider,
] as const;

let registered = false;
const policyEvaluationCache = new WeakMap<HealthCheckContext, Promise<PolicyEvaluation>>();

export type PolicyEvaluation = {
  readonly policyPath: string;
  readonly policy?: {
    readonly value: unknown;
    readonly hash: string;
  };
  readonly evidence: PolicyEvidence;
  readonly findings: readonly HealthFinding[];
};

export function registerPolicyDoctorChecks(): void {
  if (registered) {
    return;
  }
  registerHealthCheck(policyMissingFileCheck);
  registerHealthCheck(policyHashMismatchCheck);
  registerHealthCheck(policyChannelsDeniedProviderCheck);
  registered = true;
}

export function resetPolicyDoctorChecksForTest(): void {
  registered = false;
}

export function evaluatePolicy(ctx: HealthCheckContext): Promise<PolicyEvaluation> {
  const cached = policyEvaluationCache.get(ctx);
  if (cached !== undefined) {
    return cached;
  }
  const next = evaluatePolicyUncached(ctx);
  policyEvaluationCache.set(ctx, next);
  return next;
}

const policyMissingFileCheck: HealthCheck = {
  id: CHECK_IDS.policyMissingFile,
  kind: "plugin",
  description: "The enabled policy extension has a policy file to verify.",
  source: "policy",
  async detect(ctx) {
    return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyMissingFile);
  },
};

const policyHashMismatchCheck: HealthCheck = {
  id: CHECK_IDS.policyHashMismatch,
  kind: "plugin",
  description: "The policy file matches the configured expected hash.",
  source: "policy",
  async detect(ctx) {
    return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyHashMismatch);
  },
};

const policyChannelsDeniedProviderCheck: HealthCheck = {
  id: CHECK_IDS.policyDeniedChannelProvider,
  kind: "plugin",
  description: "Configured channels satisfy policy deny rules.",
  source: "policy",
  async detect(ctx) {
    return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyDeniedChannelProvider);
  },
  async repair(ctx, findings) {
    if (!(await workspaceRepairsEnabled(ctx))) {
      return workspaceRepairsDisabledResult("channel config");
    }
    const channelIds = channelIdsFromFindings(findings);
    if (channelIds.length === 0) {
      return {
        status: "skipped",
        reason: "no channel findings matched a configurable channel",
        changes: [],
      };
    }
    const next = disableChannels(ctx.cfg, channelIds);
    if (next.changed.length === 0) {
      return {
        status: "skipped",
        reason: "matching channels were already disabled or missing",
        changes: [],
      };
    }
    return {
      config: next.config,
      changes: next.changed.map((id) => `Disabled channels.${id}.enabled for policy conformance.`),
    };
  },
};

async function evaluatePolicyUncached(ctx: HealthCheckContext): Promise<PolicyEvaluation> {
  const settings = policySettings(ctx);
  const policyPath = policyDisplayName(ctx);
  const evidence = collectPolicyEvidence(ctx.cfg as Record<string, unknown>);
  const findings: HealthFinding[] = [];

  if (settings.enabled === false) {
    return { policyPath, evidence, findings };
  }

  const policyFile = await readPolicyFile(ctx);
  if (policyFile === null) {
    findings.push({
      checkId: CHECK_IDS.policyMissingFile,
      severity: "warning",
      message: `${policyPath} is missing for the enabled policy extension.`,
      source: "policy",
      path: policyPath,
      fixHint: `Restore ${policyPath} or add the policy artifact for this workspace.`,
    });
    return { policyPath, evidence, findings };
  }

  const parsedPolicy = parsePolicyFile(policyFile.raw, policyFile.displayName);
  if (parsedPolicy.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { policyPath, evidence, findings };
  }

  const policy = parsedPolicy.ast.root === null ? {} : jsoncValueToUnknown(parsedPolicy.ast.root);
  const policyHash = policyDocumentHash(policy);
  const expectedHash = settings.expectedHash;
  if (
    typeof expectedHash === "string" &&
    expectedHash.trim() !== "" &&
    policyHash !== expectedHash.trim()
  ) {
    findings.push({
      checkId: CHECK_IDS.policyHashMismatch,
      severity: "error",
      message: `${policyFile.displayName} does not match the configured policy hash.`,
      source: "policy",
      path: policyFile.displayName,
      target: `oc://${policyFile.ocDocName}`,
      requirement: "oc://openclaw.config/plugins/entries/policy/config/expectedHash",
      fixHint: `Restore the approved policy artifact or update plugins.entries.policy.config.expectedHash after review.`,
    });
  }

  if (policyRuleEnabledFromSnapshot(settings, policy, "checkChannels")) {
    findings.push(...channelFindings(policy, policyFile.ocDocName, evidence));
  }

  return {
    policyPath,
    policy: { value: policy, hash: policyHash },
    evidence,
    findings,
  };
}

function findingsForCheck(
  evaluation: PolicyEvaluation,
  checkId: (typeof POLICY_CHECK_IDS)[number],
): readonly HealthFinding[] {
  return evaluation.findings.filter((finding) => finding.checkId === checkId);
}

function channelFindings(
  policy: unknown,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  const denyRules = readChannelDenyRules(policy, policyDocName);
  if (denyRules.length === 0) {
    return [];
  }
  return evidence.channels.flatMap((channel): HealthFinding[] => {
    if (channel.enabled === false) {
      return [];
    }
    const rule = denyRules.find((candidate) => candidate.when?.provider === channel.provider);
    if (rule === undefined) {
      return [];
    }
    return [
      {
        checkId: CHECK_IDS.policyDeniedChannelProvider,
        severity: "error",
        message: `Channel '${channel.id}' uses denied provider '${channel.provider}'.`,
        source: "policy",
        path: "openclaw config",
        ocPath: channel.ocPath,
        target: channel.ocPath,
        requirement: rule.requirement,
        fixHint:
          rule.reason ??
          "Disable this channel, remove it from config, or update the policy deny rule.",
      },
    ];
  });
}

async function readPolicyFile(
  ctx: HealthCheckContext,
): Promise<{ raw: string; path: string; displayName: string; ocDocName: string } | null> {
  const displayName = policyDisplayName(ctx);
  const path = resolveWorkspacePath(ctx, policyPathSetting(ctx));
  try {
    const fs = await import("node:fs/promises");
    return {
      raw: await fs.readFile(path, "utf-8"),
      path,
      displayName,
      ocDocName: basename(displayName),
    };
  } catch (err) {
    if (isNotFound(err)) {
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

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

function parsePolicyFile(
  raw: string,
  fileName: string,
): {
  readonly ast: JsoncAst;
  readonly diagnostics: readonly Diagnostic[];
} {
  const parsed = parseOcDocument(raw, { fileName });
  if (parsed.ast.kind !== "jsonc") {
    throw new Error(`${fileName} did not parse as jsonc.`);
  }
  return { ast: parsed.ast, diagnostics: parsed.diagnostics };
}

async function workspaceRepairsEnabled(ctx: HealthCheckContext): Promise<boolean> {
  return (await resolvePolicyBooleanSetting(ctx, "workspaceRepairs")) === true;
}

function workspaceRepairsDisabledResult(fileName: string): {
  readonly status: "skipped";
  readonly reason: string;
  readonly changes: readonly string[];
  readonly warnings: readonly string[];
} {
  const reason = "workspace repairs are disabled";
  return {
    status: "skipped",
    reason,
    changes: [],
    warnings: [
      `Skipped ${fileName} repair. Enable plugins.entries.policy.config.workspaceRepairs to let doctor --fix edit workspace files.`,
    ],
  };
}

function readChannelDenyRules(
  policy: unknown,
  policyDocName: string,
): readonly {
  readonly id?: string;
  readonly when?: { readonly provider?: string };
  readonly reason?: string;
  readonly requirement: string;
}[] {
  if (
    !isRecord(policy) ||
    !isRecord(policy.channels) ||
    !Array.isArray(policy.channels.denyRules)
  ) {
    return [];
  }
  return policy.channels.denyRules
    .map((rule, index) => ({ rule, index }))
    .filter(
      (
        entry,
      ): entry is {
        readonly index: number;
        readonly rule: {
          readonly id?: string;
          readonly when?: { readonly provider?: string };
          readonly reason?: string;
        };
      } =>
        isRecord(entry.rule) &&
        (entry.rule.id === undefined || typeof entry.rule.id === "string") &&
        (entry.rule.reason === undefined || typeof entry.rule.reason === "string") &&
        isRecord(entry.rule.when) &&
        typeof entry.rule.when.provider === "string",
    )
    .map(({ rule, index }) => ({
      ...rule,
      requirement: `oc://${policyDocName}/channels/denyRules/#${index}`,
    }));
}

function channelIdsFromFindings(findings: readonly HealthFinding[]): readonly string[] {
  return [
    ...new Set(
      findings
        .filter((finding) => finding.checkId === CHECK_IDS.policyDeniedChannelProvider)
        .map((finding) => finding.ocPath?.match(/^oc:\/\/openclaw\.config\/channels\/(.+)$/)?.[1])
        .filter((id): id is string => id !== undefined && id !== ""),
    ),
  ];
}

function disableChannels(
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

async function resolvePolicyBooleanSetting(
  ctx: HealthCheckContext,
  setting: "enabled" | "checkChannels" | "workspaceRepairs",
): Promise<boolean | undefined> {
  const configured = policySettings(ctx)[setting];
  if (typeof configured === "boolean") {
    return configured;
  }
  const file = await readPolicyFile(ctx);
  if (file === null) {
    return undefined;
  }
  const parsed = parsePolicyFile(file.raw, file.displayName);
  if (parsed.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return undefined;
  }
  return (
    readJsoncBoolean(parsed.ast, file.ocDocName, `channels.settings.${setting}`) ??
    readJsoncBoolean(parsed.ast, file.ocDocName, `settings.${setting}`) ??
    readJsoncBoolean(parsed.ast, file.ocDocName, `policy.${setting}`) ??
    readJsoncBoolean(parsed.ast, file.ocDocName, setting)
  );
}

function policySettings(ctx: HealthCheckContext): {
  readonly enabled?: boolean;
  readonly checkChannels?: boolean;
  readonly workspaceRepairs?: boolean;
  readonly expectedHash?: string;
  readonly path?: string;
} {
  const pluginConfig = ctx.cfg.plugins?.entries?.["policy"]?.config;
  if (!isRecord(pluginConfig)) {
    return {};
  }
  return pluginConfig;
}

function policyRuleEnabledFromSnapshot(
  settings: ReturnType<typeof policySettings>,
  policy: unknown,
  setting: "checkChannels",
): boolean {
  const configured = settings[setting];
  if (typeof configured === "boolean") {
    return configured;
  }
  const policyConfigured =
    readPolicyBoolean(policy, ["channels", "settings", setting]) ??
    readPolicyBoolean(policy, ["settings", setting]) ??
    readPolicyBoolean(policy, ["policy", setting]) ??
    readPolicyBoolean(policy, [setting]);
  if (policyConfigured !== undefined) {
    return policyConfigured;
  }
  return (isRecord(policy) && isRecord(policy.channels)) || settings.enabled === true;
}

function readPolicyBoolean(policy: unknown, path: readonly string[]): boolean | undefined {
  let current: unknown = policy;
  for (const part of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[part];
  }
  return typeof current === "boolean" ? current : undefined;
}

function policyPathSetting(ctx: HealthCheckContext): string {
  const configured = policySettings(ctx).path;
  return typeof configured === "string" && configured.trim() !== ""
    ? configured.trim()
    : "policy.jsonc";
}

function policyDisplayName(ctx: HealthCheckContext): string {
  const configured = policyPathSetting(ctx);
  return isAbsolute(configured) ? basename(configured) : configured;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readJsoncBoolean(ast: JsoncAst, docName: string, path: string): boolean | undefined {
  const match = resolveOcPath(ast, parseOcPath(`oc://${docName}/${path}`));
  if (match?.kind !== "leaf" || match.leafType !== "boolean") {
    return undefined;
  }
  return match.valueText === "true";
}
