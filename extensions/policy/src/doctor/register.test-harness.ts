// Policy tests cover register plugin behavior.
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runDoctorLintChecks,
  type HealthCheck,
  type HealthCheckContext,
  type HealthFinding,
  type HealthRepairContext,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/health";
import { clearHealthChecksForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  collectPolicyEvidence,
  createPolicyAttestation,
  type PolicyEvidence,
} from "../policy-state.js";
import { registerPolicyDoctorChecks } from "./register.js";

export let workspaceDir: string;

let originalOpenClawHome: string | undefined;

let originalOpenClawStateDir: string | undefined;

export function cfgWithPolicy(settings: Record<string, unknown> = {}): OpenClawConfig {
  return {
    plugins: {
      entries: {
        policy: {
          enabled: true,
          config: { enabled: true, ...settings },
        },
      },
    },
  };
}

type AuthoredAgents = NonNullable<OpenClawConfig["agents"]>;
type AuthoredEntry = NonNullable<AuthoredAgents["entries"]>[string];

export type RawLegacyDoctorConfig = Omit<OpenClawConfig, "agents"> & {
  agents?: Omit<AuthoredAgents, "entries"> & {
    entries?: Record<string, AuthoredEntry & { default?: boolean }>;
    list?: unknown[];
  };
};

type PolicyConfigFixture = RawLegacyDoctorConfig & Record<string, unknown>;

export function cfgWithPolicyOverrides(
  overrides: Partial<RawLegacyDoctorConfig> = {},
): PolicyConfigFixture {
  return { ...cfgWithPolicy(), ...overrides };
}

export function cfgWithWorkspaceRepairs(overrides: Partial<RawLegacyDoctorConfig>) {
  return { ...cfgWithPolicy({ workspaceRepairs: true }), ...overrides };
}

export function cfgWithPolicySandbox(
  sandbox: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["sandbox"],
) {
  return cfgWithPolicyOverrides({ agents: { defaults: { sandbox } } });
}

export function collectChannelOnlyPolicyEvidence(cfg: Record<string, unknown> = {}) {
  return collectPolicyEvidence(cfg, {
    includeIngress: false,
    includeGatewayExposure: false,
    includeAgentWorkspace: false,
    includeDataHandling: false,
    includeToolPosture: false,
    includeSandboxPosture: false,
    includeSecrets: false,
    includeAuthProfiles: false,
  });
}

export function createAcceptedPolicyAttestationHash(policyHash: string, evidence: PolicyEvidence) {
  return createPolicyAttestation({
    ok: true,
    checkedAt: "2026-05-10T20:00:00.000Z",
    policyPath: "policy.jsonc",
    policyHash,
    evidence,
    findings: [],
  }).attestationHash;
}

export function createReleaseAgentPolicyConfig() {
  return cfgWithPolicyOverrides({
    agents: {
      defaults: {
        sandbox: {
          mode: "all",
          backend: "docker",
          docker: {
            network: "none",
            binds: ["/workspace:/workspace:rw"],
          },
        },
      },
      entries: {
        "release-agent": {
          sandbox: { mode: "all", backend: "openshell" },
        },
      },
    },
  });
}

export function createCanonicalModelPolicyConfig() {
  return rawCfgWithPolicy({
    models: {
      providers: {
        "aws-bedrock": {},
      },
    },
    agents: {
      defaults: {
        model: "OpenRouter/openai/gpt-5.5",
      },
    },
  });
}

export function createInheritedAgentPolicyConfig() {
  return cfgWithPolicyOverrides({
    tools: { exec: { host: "node" } },
    agents: {
      defaults: {
        sandbox: { mode: "all", workspaceAccess: "rw" },
      },
      entries: {
        support: {
          sandbox: { mode: "all", workspaceAccess: "ro" },
          tools: { exec: { host: "sandbox" } },
        },
      },
    },
  });
}

export function createNamedAllowlistAccounts() {
  return {
    work: {
      dmPolicy: "allowlist",
      groupPolicy: "allowlist",
      requireMention: true,
    },
  };
}

export function policyForAgents(
  scopeName: string,
  agentIds: string[],
  rules: Record<string, unknown>,
) {
  return { scopes: { [scopeName]: { agentIds, ...rules } } };
}

export function createDeniedTelegramPolicy(reason?: string) {
  return {
    channels: {
      denyRules: [
        {
          id: "no-telegram",
          when: { provider: "telegram" },
          ...(reason === undefined ? {} : { reason }),
        },
      ],
    },
  };
}

export function createGatewayHttpInput() {
  return {
    endpoints: {
      chatCompletions: {
        enabled: true,
        images: { allowUrl: true },
      },
      responses: {
        enabled: true,
        files: { allowUrl: true },
        images: { allowUrl: true, urlAllowlist: ["images.example.test"] },
      },
    },
  };
}

export function createDocsMcpPolicyConfig() {
  return cfgWithPolicyOverrides({
    mcp: {
      servers: {
        DocsServer: {
          command: "uvx",
          args: ["mcp-server-fetch"],
        },
      },
    },
  });
}

export function createStandardIngressPolicy() {
  return {
    session: { requireDmScope: "per-channel-peer" },
    channels: {
      allowDmPolicies: ["pairing", "allowlist", "disabled"],
      denyOpenGroups: true,
      requireMentionInGroups: true,
    },
  };
}

export function createDisabledOpenChannelInput() {
  return {
    enabled: false,
    dmPolicy: "open",
    groupPolicy: "open",
    requireMention: false,
  };
}

export function createOpenOpsGroups() {
  return {
    ops: {
      groupPolicy: "open",
      requireMention: false,
    },
  };
}

export function cfgWithPolicyAgents(agents: RawLegacyDoctorConfig["agents"]) {
  return cfgWithPolicyOverrides({ agents });
}

export function cfgWithPolicyAgentDefaults(
  defaults: NonNullable<RawLegacyDoctorConfig["agents"]>["defaults"],
) {
  return cfgWithPolicyAgents({ defaults });
}

export function cfgWithPolicyAgentEntries(
  entries: NonNullable<RawLegacyDoctorConfig["agents"]>["entries"],
) {
  return cfgWithPolicyAgents({ entries });
}

export async function runToolMetadataFixture(required: string[], toolsRaw: string) {
  const configPath = await writePolicyFixture({ tools: { requireMetadata: required } });
  await fs.writeFile(join(workspaceDir, "AGENTS.md"), toolsRaw, "utf-8");
  return runPolicyDoctorLint(ctx(configPath, cfgWithPolicy()));
}

export function createToolPosturePolicy(allowSecurity: string[]) {
  return {
    tools: {
      profiles: { allow: ["messaging", "minimal"] },
      fs: { requireWorkspaceOnly: true },
      exec: { allowSecurity, requireAsk: ["always"], allowHosts: ["sandbox"] },
      elevated: { allow: false },
      denyTools: ["exec", "write", "edit", "apply_patch"],
    },
  };
}

export function createCustomBindInput(bind: "loopback" | "custom", customBindHost: string) {
  return { gateway: { bind, customBindHost } };
}

export function createBackendContainerPolicy(allowBackends: string[]) {
  return {
    sandbox: {
      allowBackends,
      containers: {
        denyHostNetwork: true,
        denyContainerRuntimeSocketMounts: true,
        denyUnconfinedProfiles: true,
      },
    },
  };
}

export function createSharedSandboxRequirements(allowBackends: string[]) {
  return {
    sandbox: {
      requireMode: ["all", "non-main"],
      allowBackends,
      containers: {
        denyHostNetwork: true,
        denyContainerNamespaceJoin: true,
        requireReadOnlyMounts: true,
        denyContainerRuntimeSocketMounts: true,
        denyUnconfinedProfiles: true,
      },
      browser: { requireCdpSourceRange: true },
    },
  };
}

export function rawCfgWithPolicy(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...cfgWithPolicy(), ...overrides };
}

export async function writePolicyFixture(
  ...json: Parameters<typeof JSON.stringify>
): Promise<string> {
  const [policy] = json;
  const configPath = join(workspaceDir, "openclaw.jsonc");
  await fs.writeFile(configPath, "{}", "utf-8");
  await fs.writeFile(
    join(workspaceDir, "policy.jsonc"),
    typeof policy === "string" ? policy : JSON.stringify(...json),
    "utf-8",
  );
  return configPath;
}

export function ctx(configPath: string, cfg: OpenClawConfig = {}): HealthCheckContext {
  return {
    mode: "lint",
    runtime: {
      log() {},
      error() {},
      exit() {},
    },
    cfg,
    cwd: workspaceDir,
    configPath,
  };
}

export function repairCtx(configPath: string, cfg: OpenClawConfig = {}): HealthRepairContext {
  return {
    ...ctx(configPath, cfg),
    mode: "fix",
  };
}

export function registerChecks(): readonly HealthCheck[] {
  const checks: HealthCheck[] = [];
  registerPolicyDoctorChecks({
    registerHealthCheck(check) {
      checks.push(check);
    },
  });
  return checks;
}

export async function runPolicyChecks(checkCtx: HealthCheckContext): Promise<{
  readonly findings: readonly HealthFinding[];
}> {
  const checks = registerChecks();
  const findings: HealthFinding[] = [];
  for (const check of checks) {
    findings.push(...(check.detect === undefined ? [] : await check.detect(checkCtx)));
  }
  return { findings };
}

export async function runPolicyChecksFixture(
  policy: unknown,
  cfg: OpenClawConfig = cfgWithPolicy(),
) {
  return runPolicyChecks(ctx(await writePolicyFixture(policy), cfg));
}

export async function runPolicyDoctorLint(
  checkCtx: HealthCheckContext,
): Promise<Awaited<ReturnType<typeof runDoctorLintChecks>>> {
  return runDoctorLintChecks(checkCtx, { checks: registerChecks() });
}

export async function runGlobalPolicyDoctorFixture(cfg: OpenClawConfig, policy: unknown) {
  const checkContext = ctx(await writePolicyFixture(policy), cfg);
  registerPolicyDoctorChecks();
  return runDoctorLintChecks(checkContext);
}

export async function runPolicyRepairCheck(checkId: string, repairCheckCtx: HealthRepairContext) {
  const check = registerChecks().find((entry) => entry.id === checkId);
  if (check?.detect === undefined || check.repair === undefined) {
    throw new Error(`${checkId} repair check was not registered`);
  }
  const findings = await check.detect(repairCheckCtx);
  const result = await check.repair(repairCheckCtx, findings);
  const config = result.config ?? repairCheckCtx.cfg;
  const remainingFindings =
    repairCheckCtx.dryRun === true ? [] : await check.detect({ ...repairCheckCtx, cfg: config });
  return { ...result, findings, config, remainingFindings };
}

export const setupPolicyDoctorTest = async () => {
  clearHealthChecksForTest();
  originalOpenClawHome = process.env.OPENCLAW_HOME;
  originalOpenClawStateDir = process.env.OPENCLAW_STATE_DIR;
  workspaceDir = await fs.mkdtemp(join(tmpdir(), "policy-doctor-"));
  process.env.OPENCLAW_HOME = workspaceDir;
  delete process.env.OPENCLAW_STATE_DIR;
  await fs.mkdir(join(workspaceDir, ".openclaw"), { recursive: true });
  try {
    await fs.symlink(
      "../exec-approvals.json",
      join(workspaceDir, ".openclaw", "exec-approvals.json"),
    );
  } catch (err) {
    if (typeof err !== "object" || err === null || !("code" in err) || err.code !== "EPERM") {
      throw err;
    }
    await fs.rm(join(workspaceDir, ".openclaw"), { recursive: true, force: true });
    await fs.symlink(workspaceDir, join(workspaceDir, ".openclaw"), "junction");
  }
};

export const teardownPolicyDoctorTest = async () => {
  if (originalOpenClawHome === undefined) {
    delete process.env.OPENCLAW_HOME;
  } else {
    process.env.OPENCLAW_HOME = originalOpenClawHome;
  }
  if (originalOpenClawStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalOpenClawStateDir;
  }
  await fs.rm(workspaceDir, { recursive: true, force: true });
  clearHealthChecksForTest();
};
