import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Command } from "commander";
import { clearConfigCache } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerPolicyCli } from "./cli.js";
import { createPolicyAttestation } from "./policy-state.js";

let workspaceDir: string;

type PolicyCheckCliOptions = {
  readonly severityMin?: string;
};

type PolicyWatchCliOptions = {
  readonly intervalMs?: string;
};

type PolicyCompareCliOptions = {
  readonly baseline: string;
  readonly policy?: string;
};

async function runPolicyCli(args: readonly string[]) {
  const output: string[] = [];
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    output.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    output.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  const consoleError = vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => {
    output.push(`${values.map(String).join(" ")}\n`);
  });
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const program = new Command().name("openclaw");
    registerPolicyCli(program);
    await program.parseAsync(["policy", ...args], { from: "user" });
    const lastOutput = output.at(-1) ?? "";
    const parsed = /^[{[]/.test(lastOutput.trimStart()) ? JSON.parse(lastOutput) : {};
    return { exitCode: process.exitCode ?? 0, parsed, output };
  } finally {
    process.exitCode = previousExitCode;
    stdout.mockRestore();
    stderr.mockRestore();
    consoleError.mockRestore();
  }
}

async function runPolicyCheckJson(options: PolicyCheckCliOptions = {}) {
  return runPolicyCli([
    "check",
    "--json",
    ...(options.severityMin === undefined ? [] : ["--severity-min", options.severityMin]),
  ]);
}

async function runPolicyWatchJson(options: PolicyWatchCliOptions = {}) {
  return runPolicyCli([
    "watch",
    "--json",
    "--once",
    ...(options.intervalMs === undefined ? [] : ["--interval-ms", options.intervalMs]),
  ]);
}

function workspacePath(value: string): string {
  return isAbsolute(value) ? value : join(workspaceDir, value);
}

async function writeFixture(path: string, value: unknown): Promise<void> {
  await fs.writeFile(path, typeof value === "string" ? value : JSON.stringify(value), "utf-8");
}

async function runPolicyCompareJson(options: PolicyCompareCliOptions) {
  return runPolicyCli([
    "compare",
    "--json",
    "--baseline",
    workspacePath(options.baseline),
    ...(options.policy === undefined ? [] : ["--policy", workspacePath(options.policy)]),
  ]);
}

async function runPolicyCompareFixture(baseline: unknown, policy: unknown = {}) {
  await writeFixture(join(workspaceDir, "baseline.policy.jsonc"), baseline);
  await writeFixture(join(workspaceDir, "policy.jsonc"), policy);
  return runPolicyCompareJson({ baseline: "baseline.policy.jsonc" });
}

async function writeExplicitFleetConfig(): Promise<{
  readonly alphaWorkspace: string;
  readonly betaWorkspace: string;
}> {
  const alphaWorkspace = join(workspaceDir, "alpha-workspace");
  const betaWorkspace = join(workspaceDir, "beta-workspace");
  await Promise.all([
    fs.mkdir(alphaWorkspace, { recursive: true }),
    fs.mkdir(betaWorkspace, { recursive: true }),
  ]);
  const configPath = join(workspaceDir, "openclaw.jsonc");
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  await writeFixture(configPath, {
    agents: {
      ownership: "explicit",
      entries: {
        alpha: { workspace: alphaWorkspace },
        beta: { workspace: betaWorkspace },
      },
    },
    plugins: {
      entries: {
        policy: { enabled: true, config: { enabled: true, path: "policy.jsonc" } },
      },
    },
  });
  clearConfigCache();
  return { alphaWorkspace, betaWorkspace };
}

describe("policy commands", () => {
  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(join(tmpdir(), "policy-cli-"));
    vi.stubEnv("OPENCLAW_WORKSPACE_DIR", workspaceDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    clearConfigCache();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("checks authored routing probes without exposing route identifiers", async () => {
    const peerId = "+15555550123-private";
    const configPath = join(workspaceDir, "openclaw.jsonc");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    await writeFixture(configPath, {
      plugins: { entries: { policy: { enabled: true, config: { enabled: true } } } },
      agents: { entries: { main: {} } },
      channels: { imessage: { enabled: false } },
      bindings: [],
    });
    await writeFixture(join(workspaceDir, "policy.jsonc"), {
      routing: {
        requireBindings: true,
        requireConfiguredChannels: true,
        probes: [
          {
            id: "family-dm",
            route: { channel: "imessage", peer: { kind: "direct", id: peerId } },
            expect: { agentId: "family", matchedBy: ["binding.peer"] },
          },
        ],
      },
    });

    const { exitCode, parsed, output } = await runPolicyCheckJson();

    expect(exitCode).toBe(1);
    expect(parsed.findings.map((finding: { checkId: string }) => finding.checkId)).toEqual([
      "policy/routing-bindings-required",
      "policy/routing-agent-mismatch",
      "policy/routing-match-kind-mismatch",
    ]);
    expect(parsed.evidence.routing.probes).toEqual([
      expect.objectContaining({ id: "family-dm", agentId: "main", matchedBy: "default" }),
    ]);
    expect(output.join("\n")).not.toContain(peerId);
  });

  it.each([
    {
      name: "reports malformed policy rules in policy check output",
      policy: { channels: { denyRules: [{ when: {} }] } },
      target: "oc://policy.jsonc/channels/denyRules/#0",
    },
    {
      name: "reports malformed policy containers in policy check output",
      policy: { tools: [] },
      target: "oc://policy.jsonc/tools",
    },
  ])("$name", async ({ policy, target }) => {
    await writeFixture(join(workspaceDir, "policy.jsonc"), policy);
    const { exitCode, parsed } = await runPolicyCheckJson();

    expect(exitCode).toBe(1);
    expect(parsed).toMatchObject({
      ok: false,
      findings: [{ checkId: "policy/policy-jsonc-invalid", target }],
    });
  });

  it("links policy findings to evidence and policy requirement refs", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    await writeFixture(configPath, {
      plugins: {
        entries: {
          policy: { enabled: true, config: { enabled: true } },
        },
      },
      channels: { telegram: { enabled: true } },
    });
    await writeFixture(join(workspaceDir, "policy.jsonc"), {
      channels: {
        denyRules: [{ id: "no-telegram", when: { provider: "telegram" } }],
      },
    });
    const { exitCode, parsed } = await runPolicyCheckJson();

    expect(exitCode).toBe(1);
    expect(parsed).toMatchObject({
      evidence: {
        channels: [
          {
            id: "telegram",
            source: "oc://openclaw.config/channels/telegram",
          },
        ],
      },
      findings: [
        {
          checkId: "policy/channels-denied-provider",
          ocPath: "oc://openclaw.config/channels/telegram",
          target: "oc://openclaw.config/channels/telegram",
          requirement: "oc://policy.jsonc/channels/denyRules/#0",
          policy: {
            fixRecommendation: {
              fixClass: "automatic",
              policyPath: ["channels", "denyRules"],
              configTargets: ["channels"],
              summary: "Disable product-managed channels matching the denied provider.",
            },
          },
        },
      ],
    });
    const attestedFinding = { ...parsed.findings[0] };
    expect(attestedFinding.policy).toBeDefined();
    delete attestedFinding.policy;
    const attestedOutput = createPolicyAttestation({
      ok: false,
      checkedAt: parsed.attestation.checkedAt,
      policyPath: "policy.jsonc",
      policyHash: parsed.attestation.policy.hash,
      evidence: parsed.evidence,
      findings: [attestedFinding],
    });
    const reportedOutput = createPolicyAttestation({
      ok: false,
      checkedAt: parsed.attestation.checkedAt,
      policyPath: "policy.jsonc",
      policyHash: parsed.attestation.policy.hash,
      evidence: parsed.evidence,
      findings: parsed.findings,
    });
    expect(parsed.attestation.findingsHash).toBe(attestedOutput.findingsHash);
    expect(parsed.attestation.findingsHash).not.toBe(reportedOutput.findingsHash);
  });

  it("attests underlying policy findings when the accepted attestation is stale", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    await writeFixture(configPath, {
      plugins: {
        entries: {
          policy: {
            enabled: true,
            config: { enabled: true, expectedAttestationHash: "sha256:not-current" },
          },
        },
      },
      channels: { telegram: { enabled: true } },
    });
    await writeFixture(join(workspaceDir, "policy.jsonc"), {
      channels: {
        denyRules: [{ id: "no-telegram", when: { provider: "telegram" } }],
      },
    });
    const { exitCode, parsed } = await runPolicyCheckJson();

    expect(exitCode).toBe(1);
    expect(parsed.findings).toEqual([
      expect.objectContaining({ checkId: "policy/attestation-hash-mismatch" }),
    ]);
    const emptyOutput = createPolicyAttestation({
      ok: false,
      checkedAt: parsed.attestation.checkedAt,
      policyPath: "policy.jsonc",
      policyHash: parsed.attestation.policy.hash,
      evidence: parsed.evidence,
      findings: [],
    });
    expect(parsed.attestation.findingsHash).not.toBe(emptyOutput.findingsHash);
    expect(parsed.attestation.attestationHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("reports stale accepted attestations in policy watch", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    await writeFixture(configPath, {
      plugins: {
        entries: {
          policy: {
            enabled: true,
            config: { enabled: true, expectedAttestationHash: "sha256:not-current" },
          },
        },
      },
    });
    await writeFixture(join(workspaceDir, "policy.jsonc"), { channels: { denyRules: [] } });

    const { exitCode, parsed } = await runPolicyWatchJson();

    expect(exitCode).toBe(1);
    expect(parsed).toMatchObject({
      status: "stale",
      expectedAttestationHash: "sha256:not-current",
      findings: [
        {
          checkId: "policy/attestation-hash-mismatch",
        },
      ],
    });
  });

  it("rejects partial policy watch intervals before evaluating policy", async () => {
    const { exitCode, output } = await runPolicyWatchJson({ intervalMs: "500ms" });

    expect(exitCode).toBe(2);
    expect(output.join("\n")).toContain("--interval-ms must be an integer >= 250.");
  });

  it("reports findings before stale when accepted attestation exists", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    await writeFixture(configPath, {
      plugins: {
        entries: {
          policy: {
            enabled: true,
            config: { enabled: true, expectedAttestationHash: "sha256:not-current" },
          },
        },
      },
    });
    await writeFixture(join(workspaceDir, "policy.jsonc"), "{ channels: ");

    const { exitCode, parsed } = await runPolicyWatchJson();

    expect(exitCode).toBe(1);
    expect(parsed).toMatchObject({
      status: "findings",
      expectedAttestationHash: "sha256:not-current",
      findings: [
        {
          checkId: "policy/policy-jsonc-invalid",
        },
      ],
    });
  });

  it("rejects invalid severity thresholds", async () => {
    const { exitCode, output } = await runPolicyCheckJson({ severityMin: "warnng" });

    expect(exitCode).toBe(2);
    expect(output).toEqual([
      "Invalid --severity-min value. Expected one of: info, warning, error.\n",
    ]);
  });

  it("fails closed when the OpenClaw config is invalid", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    await writeFixture(configPath, "{");
    const { exitCode, parsed } = await runPolicyCheckJson();

    expect(exitCode).toBe(1);
    expect(parsed.attestation).toBeUndefined();
    expect(parsed.findings).toEqual([
      expect.objectContaining({ checkId: "policy/config-invalid", severity: "error" }),
    ]);
  });

  it("checks policy file conformance with metadata-backed global rules", async () => {
    const { exitCode, parsed } = await runPolicyCompareFixture(
      {
        channels: { denyRules: [{ when: { provider: "telegram" } }] },
        mcp: { servers: { allow: ["docs", "audit"], deny: ["untrusted"] } },
        models: { providers: { allow: ["openai", "anthropic"], deny: ["openrouter"] } },
        network: { privateNetwork: { allow: false } },
        ingress: { session: { requireDmScope: "per-peer" } },
        gateway: {
          exposure: { allowNonLoopbackBind: false },
          auth: { requireAuth: true },
          http: { denyEndpoints: ["responses"] },
        },
        tools: { requireMetadata: ["risk"] },
        secrets: { requireManagedProviders: true, denySources: ["env"] },
        auth: { profiles: { allowModes: ["oauth", "token"], requireMetadata: ["provider"] } },
      },
      {
        channels: { denyRules: [{ when: { provider: "telegram" } }] },
        mcp: { servers: { allow: ["docs"], deny: ["untrusted", "shadow"] } },
        models: { providers: { allow: ["openai"], deny: ["openrouter", "local"] } },
        network: { privateNetwork: { allow: false } },
        ingress: { session: { requireDmScope: "per-channel-peer" } },
        gateway: {
          exposure: { allowNonLoopbackBind: false },
          auth: { requireAuth: true },
          http: { denyEndpoints: ["responses", "chatCompletions"] },
        },
        tools: { requireMetadata: ["risk", "owner"] },
        secrets: { requireManagedProviders: true, denySources: ["env", "file"] },
        auth: { profiles: { allowModes: ["oauth"], requireMetadata: ["provider", "mode"] } },
      },
    );

    expect(exitCode).toBe(0);
    expect(parsed).toMatchObject({
      ok: true,
      baselinePath: "baseline.policy.jsonc",
      policyPath: "policy.jsonc",
      findings: [],
    });
    expect(parsed.rulesChecked).toBeGreaterThan(10);
  });

  it("accepts exec approval allowlist conformance entries with argPattern", async () => {
    const policy = {
      execApprovals: {
        agents: {
          allowAutoAllowSkills: false,
          allowlist: {
            expected: ["status", { pattern: "calendar-cli", argPattern: "^sync\\b" }],
          },
        },
      },
    };
    const { exitCode, parsed } = await runPolicyCompareFixture(policy, policy);

    expect(exitCode).toBe(0);
    expect(parsed).toMatchObject({
      ok: true,
      findings: [],
    });
  });

  it("treats retained routing probes and narrower match kinds as conformant", async () => {
    const baselineProbe = {
      id: "family-dm",
      route: { channel: "imessage", peer: { kind: "direct", id: "private-peer" } },
      expect: { agentId: "family", matchedBy: ["binding.peer", "binding.account"] },
    };
    const { exitCode, parsed } = await runPolicyCompareFixture(
      {
        routing: { requireBindings: true, probes: [baselineProbe] },
      },
      {
        routing: {
          requireBindings: true,
          probes: [
            {
              ...baselineProbe,
              expect: { ...baselineProbe.expect, matchedBy: ["binding.peer"] },
            },
            {
              id: "group-fallback",
              route: { channel: "imessage", peer: { kind: "group", id: "private-group" } },
              expect: { agentId: "groups", matchedBy: ["binding.channel"] },
            },
          ],
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(parsed).toMatchObject({ ok: true, findings: [] });
  });

  it("rejects removed or redirected routing probes as weaker", async () => {
    const baselineProbe = {
      id: "family-dm",
      route: { channel: "imessage", peer: { kind: "direct", id: "private-peer" } },
      expect: { agentId: "family", matchedBy: ["binding.peer"] },
    };
    const { exitCode, parsed } = await runPolicyCompareFixture(
      {
        routing: { probes: [baselineProbe] },
      },
      {
        routing: {
          probes: [
            {
              ...baselineProbe,
              expect: { ...baselineProbe.expect, agentId: "main" },
            },
          ],
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(parsed.findings).toEqual([
      expect.objectContaining({ checkId: "policy/policy-conformance-weaker" }),
    ]);
  });

  it("rejects unsupported exec approval allowlist requirement keys in policy compare", async () => {
    const { exitCode, parsed } = await runPolicyCompareFixture(
      {
        execApprovals: {
          agents: {
            allowlist: {
              expected: [{ pattern: "deploy", argpattern: "^--prod$" }],
            },
          },
        },
      },
      {
        execApprovals: {
          agents: {
            allowlist: {
              expected: [{ pattern: "deploy", argPattern: "^--prod$" }],
            },
          },
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(parsed).toMatchObject({
      ok: false,
      rulesChecked: 0,
    });
    expect(parsed.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/policy-conformance-invalid",
          target: "oc://baseline.policy.jsonc/execApprovals/agents/allowlist/expected/#0",
        }),
      ]),
    );
  });

  it("reports missing and weaker policy file conformance rules", async () => {
    await writeFixture(join(workspaceDir, "baseline.policy.jsonc"), {
      channels: { denyRules: [{ when: { provider: "telegram" } }] },
      network: { privateNetwork: { allow: false } },
      gateway: { auth: { requireAuth: true } },
      secrets: { denySources: ["env"] },
    });
    await writeFixture(join(workspaceDir, "candidate.policy.jsonc"), {
      channels: { denyRules: [{ when: { provider: "Telegram" } }] },
      network: { privateNetwork: { allow: true } },
      secrets: { denySources: [] },
    });

    const { exitCode, parsed } = await runPolicyCompareJson({
      baseline: "baseline.policy.jsonc",
      policy: "candidate.policy.jsonc",
    });

    expect(exitCode).toBe(1);
    expect(parsed.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/policy-conformance-weaker",
          requirement: "oc://baseline.policy.jsonc/channels/denyRules",
        }),
        expect.objectContaining({
          checkId: "policy/policy-conformance-weaker",
          requirement: "oc://baseline.policy.jsonc/network/privateNetwork/allow",
        }),
        expect.objectContaining({
          checkId: "policy/policy-conformance-missing",
          requirement: "oc://baseline.policy.jsonc/gateway/auth/requireAuth",
        }),
        expect.objectContaining({
          checkId: "policy/policy-conformance-weaker",
          requirement: "oc://baseline.policy.jsonc/secrets/denySources",
        }),
      ]),
    );
  });

  it("returns JSON findings for missing policy compare files", async () => {
    await writeFixture(join(workspaceDir, "policy.jsonc"), {});

    const { exitCode, parsed } = await runPolicyCompareJson({
      baseline: "missing.policy.jsonc",
    });

    expect(exitCode).toBe(1);
    expect(parsed).toMatchObject({
      ok: false,
      rulesChecked: 0,
      findings: [
        {
          checkId: "policy/policy-conformance-invalid",
          target: "oc://missing.policy.jsonc",
        },
      ],
    });
  });

  it("rejects scoped policy rules that do not have a valid supported selector", async () => {
    const { exitCode, parsed } = await runPolicyCompareFixture({
      scopes: {
        missingSelector: { tools: { exec: { allowHosts: ["sandbox"] } } },
        wrongSelector: {
          channelIds: ["telegram"],
          tools: { exec: { allowHosts: ["sandbox"] } },
        },
      },
    });

    expect(exitCode).toBe(1);
    expect(parsed.findings).toEqual(
      expect.arrayContaining(
        ["missingSelector", "wrongSelector"].map((scope) =>
          expect.objectContaining({
            checkId: "policy/policy-conformance-invalid",
            target: `oc://baseline.policy.jsonc/scopes/${scope}/tools/exec/allowHosts`,
          }),
        ),
      ),
    );
  });

  it("rejects gateway HTTP endpoint ids with invalid casing during policy file conformance", async () => {
    const { exitCode, parsed } = await runPolicyCompareFixture(
      {
        gateway: { http: { denyEndpoints: ["chatCompletions"] } },
      },
      {
        gateway: { http: { denyEndpoints: ["chatcompletions"] } },
      },
    );

    expect(exitCode).toBe(1);
    expect(parsed.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/policy-conformance-invalid",
          target: "oc://policy.jsonc/gateway/http/denyEndpoints/#0",
        }),
      ]),
    );
  });

  it("allows a top-level candidate rule to satisfy a scoped baseline rule", async () => {
    const { exitCode, parsed } = await runPolicyCompareFixture(
      {
        scopes: {
          release: {
            agentIds: ["main"],
            tools: { exec: { allowHosts: ["sandbox"] } },
          },
          telegram: {
            channelIds: ["telegram"],
            ingress: { channels: { requireMentionInGroups: true } },
          },
        },
      },
      {
        tools: { exec: { allowHosts: ["sandbox"] } },
        ingress: { channels: { requireMentionInGroups: true } },
      },
    );

    expect(exitCode).toBe(0);
    expect(parsed.findings).toEqual([]);
  });

  it("rejects a weaker scoped candidate override even when top-level policy satisfies baseline", async () => {
    const { exitCode, parsed } = await runPolicyCompareFixture(
      {
        scopes: {
          release: {
            agentIds: ["main"],
            tools: { exec: { allowHosts: ["sandbox"] } },
          },
        },
      },
      {
        tools: { exec: { allowHosts: ["sandbox"] } },
        scopes: {
          release: {
            agentIds: ["main"],
            tools: { exec: { allowHosts: ["sandbox", "node"] } },
          },
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(parsed.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/policy-conformance-invalid",
        requirement: "oc://policy.jsonc/scopes/release/tools/exec/allowHosts",
        target: "oc://policy.jsonc/scopes/release/tools/exec/allowHosts",
      }),
    ]);
  });

  it("accepts stricter later scoped candidate overlays during policy compare", async () => {
    const { exitCode, parsed } = await runPolicyCompareFixture(
      {
        scopes: {
          release: {
            agentIds: ["main"],
            tools: { exec: { allowHosts: ["sandbox"] } },
          },
        },
      },
      {
        scopes: {
          team: {
            agentIds: ["main"],
            tools: { exec: { allowHosts: ["sandbox", "node"] } },
          },
          lockdown: {
            agentIds: ["main"],
            tools: { exec: { allowHosts: ["sandbox"] } },
          },
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(parsed.findings).toEqual([]);
  });

  it("rejects duplicate scoped candidates when any matching scoped value is weaker", async () => {
    const { exitCode, parsed } = await runPolicyCompareFixture(
      {
        scopes: {
          release: {
            agentIds: ["main"],
            tools: { exec: { allowHosts: ["sandbox"] } },
          },
        },
      },
      {
        scopes: {
          release: {
            agentIds: ["main"],
            tools: { exec: { allowHosts: ["sandbox"] } },
          },
          relaxed: {
            agentIds: ["main"],
            tools: { exec: { allowHosts: ["sandbox", "node"] } },
          },
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(parsed.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/policy-conformance-invalid",
        requirement: "oc://policy.jsonc/scopes/relaxed/tools/exec/allowHosts",
        target: "oc://policy.jsonc/scopes/relaxed/tools/exec/allowHosts",
      }),
    ]);
  });

  it("watches the explicitly selected workspace without inspecting the first agent", async () => {
    const { alphaWorkspace, betaWorkspace } = await writeExplicitFleetConfig();
    await writeFixture(join(alphaWorkspace, "policy.jsonc"), "{");
    await writeFixture(join(betaWorkspace, "policy.jsonc"), {});

    const { exitCode, parsed } = await runPolicyCli([
      "watch",
      "--agent",
      "beta",
      "--json",
      "--once",
    ]);

    expect(exitCode).toBe(0);
    expect(parsed).toMatchObject({
      status: "clean",
      ok: true,
      attestation: { policy: { path: "policy.jsonc" } },
      findings: [],
    });
  });

  it("resolves a relative compare policy from the explicitly selected workspace", async () => {
    const { alphaWorkspace, betaWorkspace } = await writeExplicitFleetConfig();
    const baselinePath = join(workspaceDir, "baseline.policy.jsonc");
    await writeFixture(baselinePath, { network: { privateNetwork: { allow: false } } });
    await writeFixture(join(alphaWorkspace, "policy.jsonc"), {
      network: { privateNetwork: { allow: true } },
    });
    await writeFixture(join(betaWorkspace, "policy.jsonc"), {
      network: { privateNetwork: { allow: false } },
    });

    const { exitCode, parsed } = await runPolicyCli([
      "compare",
      "--agent",
      "beta",
      "--baseline",
      baselinePath,
      "--json",
    ]);

    expect(exitCode).toBe(0);
    expect(parsed).toMatchObject({ ok: true, policyPath: "policy.jsonc", findings: [] });
  });

  it.each([
    {
      name: "check",
      args: ["check", "--json"],
      expected: "policy check has no explicit owner",
    },
    {
      name: "relative compare",
      args: ["compare", "--baseline", "baseline.policy.jsonc", "--json"],
      expected: "policy compare has no explicit owner",
    },
  ])("requires an owner for $name", async ({ args, expected }) => {
    await writeExplicitFleetConfig();
    await writeFixture(join(workspaceDir, "baseline.policy.jsonc"), {});

    const { exitCode, output } = await runPolicyCli(args);

    expect(exitCode).toBe(2);
    expect(output.join("\n")).toContain(expected);
    expect(output.join("\n")).toContain("Pass --agent <id>.");
  });

  it("rejects an unknown explicit owner with profile-aware guidance", async () => {
    await writeExplicitFleetConfig();
    vi.stubEnv("OPENCLAW_PROFILE", "testprof");
    vi.stubEnv("OPENCLAW_CONTAINER_HINT", "");

    const { exitCode, output } = await runPolicyCli(["check", "--agent", "ghost", "--json"]);

    expect(exitCode).toBe(2);
    expect(output.join("\n")).toContain(
      'Unknown agent id "ghost". Run openclaw --profile testprof agents list to see configured agents.',
    );
  });
});
