import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../../src/config/config.js";
import { runDoctorLintChecks } from "../../../../src/flows/doctor-lint-flow.js";
import { runDoctorHealthRepairs } from "../../../../src/flows/doctor-repair-flow.js";
import {
  clearHealthChecksForTest,
  listHealthChecks,
} from "../../../../src/flows/health-check-registry.js";
import type {
  HealthCheckContext,
  HealthRepairContext,
} from "../../../../src/flows/health-checks.js";
import { createPolicyAttestation, policyDocumentHash } from "../policy-state.js";
import { registerPolicyDoctorChecks, resetPolicyDoctorChecksForTest } from "./register.js";

let workspaceDir: string;

function cfgWithPolicy(settings: Record<string, unknown> = {}): OpenClawConfig {
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

function ctx(configPath: string, cfg: OpenClawConfig = {}): HealthCheckContext {
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

function repairCtx(configPath: string, cfg: OpenClawConfig = {}): HealthRepairContext {
  return {
    ...ctx(configPath, cfg),
    mode: "fix",
  };
}

describe("registerPolicyDoctorChecks", () => {
  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(join(tmpdir(), "policy-doctor-"));
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
    clearHealthChecksForTest();
    resetPolicyDoctorChecksForTest();
  });

  it("registers policy health checks once", () => {
    registerPolicyDoctorChecks();
    registerPolicyDoctorChecks();

    expect(listHealthChecks().map((check) => check.id)).toEqual([
      "policy/policy-jsonc-missing",
      "policy/policy-jsonc-invalid",
      "policy/policy-hash-mismatch",
      "policy/attestation-hash-mismatch",
      "policy/channels-denied-provider",
    ]);
  });

  it("reports a missing policy file when the policy extension is enabled", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfgWithPolicy()));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/policy-jsonc-missing",
        severity: "warning",
        path: "policy.jsonc",
      }),
    ]);
  });

  it("does not report a missing policy file when policy is disabled", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfgWithPolicy({ enabled: false })));

    expect(result.findings).toEqual([]);
  });

  it("reports invalid policy files as errors", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(join(workspaceDir, "policy.jsonc"), "{ channels: ", "utf-8");

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfgWithPolicy()));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/policy-jsonc-invalid",
        severity: "error",
        path: "policy.jsonc",
      }),
    ]);
  });

  it("reports malformed channel deny rules as policy errors", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ channels: { denyRules: [{ when: {} }] } }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfgWithPolicy()));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/policy-jsonc-invalid",
        severity: "error",
        path: "policy.jsonc",
        target: "oc://policy.jsonc/channels/denyRules/#0",
      }),
    ]);
  });

  it("reports malformed channel deny rules against a configured policy path", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "workspace.policy.jsonc"),
      JSON.stringify({ channels: { denyRules: [{ when: {} }] } }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(
      ctx(configPath, cfgWithPolicy({ path: "workspace.policy.jsonc" })),
    );

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/policy-jsonc-invalid",
        path: "workspace.policy.jsonc",
        target: "oc://workspace.policy.jsonc/channels/denyRules/#0",
      }),
    ]);
  });

  it("reports a policy hash mismatch when expectedHash is configured", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ channels: { denyRules: [] } }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(
      ctx(configPath, cfgWithPolicy({ expectedHash: "sha256:not-the-policy" })),
    );

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/policy-hash-mismatch",
        severity: "error",
        path: "policy.jsonc",
      }),
    ]);
  });

  it("does not emit repairable channel findings when the policy hash is not accepted", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy({ expectedHash: "sha256:not-the-policy", workspaceRepairs: true }),
      channels: { telegram: { enabled: true } },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        channels: {
          denyRules: [{ id: "no-telegram", when: { provider: "telegram" } }],
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings.map((finding) => finding.checkId)).toEqual([
      "policy/policy-hash-mismatch",
    ]);
  });

  it("accepts a policy file that matches the configured expectedHash", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const policy = { channels: { denyRules: [] } };
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(join(workspaceDir, "policy.jsonc"), JSON.stringify(policy), "utf-8");

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(
      ctx(configPath, cfgWithPolicy({ expectedHash: policyDocumentHash(policy) })),
    );

    expect(result.findings).toEqual([]);
  });

  it("reports an attestation mismatch when expectedAttestationHash is configured", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ channels: { denyRules: [] } }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(
      ctx(configPath, cfgWithPolicy({ expectedAttestationHash: "sha256:not-current" })),
    );

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/attestation-hash-mismatch",
        severity: "error",
        path: "policy attestation",
      }),
    ]);
  });

  it("does not emit repairable channel findings when the accepted attestation changed", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy({ expectedAttestationHash: "sha256:not-current", workspaceRepairs: true }),
      channels: { telegram: { enabled: true } },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        channels: {
          denyRules: [{ id: "no-telegram", when: { provider: "telegram" } }],
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings.map((finding) => finding.checkId)).toEqual([
      "policy/attestation-hash-mismatch",
    ]);
  });

  it("accepts a policy check that matches the configured expectedAttestationHash", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const policy = { channels: { denyRules: [] } };
    const policyHash = policyDocumentHash(policy);
    const acceptedAttestationHash = createPolicyAttestation({
      ok: true,
      checkedAt: "2026-05-10T20:00:00.000Z",
      policyPath: "policy.jsonc",
      policyHash,
      evidence: { channels: [] },
      findings: [],
    }).attestationHash;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(join(workspaceDir, "policy.jsonc"), JSON.stringify(policy), "utf-8");

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(
      ctx(configPath, cfgWithPolicy({ expectedAttestationHash: acceptedAttestationHash })),
    );

    expect(result.findings).toEqual([]);
  });

  it("reports configured channels denied by policy", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      channels: { telegram: { enabled: true } },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify(
        {
          channels: {
            denyRules: [
              {
                id: "no-telegram",
                when: { provider: "telegram" },
                reason: "Telegram is not approved for this workspace.",
              },
            ],
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/channels-denied-provider",
        severity: "error",
        path: "openclaw config",
        ocPath: "oc://openclaw.config/channels/telegram",
        target: "oc://openclaw.config/channels/telegram",
        requirement: "oc://policy.jsonc/channels/denyRules/#0",
        fixHint: "Telegram is not approved for this workspace.",
      }),
    ]);
  });

  it("repairs denied enabled channels by disabling them when workspace repairs are enabled", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy({ workspaceRepairs: true }),
      channels: { telegram: { enabled: true } },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify(
        {
          channels: {
            denyRules: [{ id: "no-telegram", when: { provider: "telegram" } }],
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorHealthRepairs(repairCtx(configPath, cfg), {
      checks: listHealthChecks().filter((entry) => entry.id === "policy/channels-denied-provider"),
    });

    expect(result.changes).toEqual(["Disabled channels.telegram.enabled for policy conformance."]);
    expect(result.remainingFindings).toEqual([]);
    expect(result.config.channels?.telegram).toEqual({ enabled: false });
  });

  it("does not repair denied channels without workspace repair opt-in", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy({ workspaceRepairs: false }),
      channels: { telegram: { enabled: true } },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify(
        {
          channels: {
            denyRules: [{ id: "no-telegram", when: { provider: "telegram" } }],
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorHealthRepairs(repairCtx(configPath, cfg), {
      checks: listHealthChecks().filter((entry) => entry.id === "policy/channels-denied-provider"),
    });

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      "Skipped channel config repair. Enable plugins.entries.policy.config.workspaceRepairs to let doctor --fix edit workspace files.",
      "policy/channels-denied-provider repair skipped: workspace repairs are disabled",
    ]);
    expect(result.config.channels?.telegram).toEqual({ enabled: true });
  });

  it("does not let policy.jsonc enable workspace repairs", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      channels: { telegram: { enabled: true } },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify(
        {
          workspaceRepairs: true,
          channels: {
            denyRules: [{ id: "no-telegram", when: { provider: "telegram" } }],
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorHealthRepairs(repairCtx(configPath, cfg), {
      checks: listHealthChecks().filter((entry) => entry.id === "policy/channels-denied-provider"),
    });

    expect(result.changes).toEqual([]);
    expect(result.warnings).toContain(
      "policy/channels-denied-provider repair skipped: workspace repairs are disabled",
    );
    expect(result.config.channels?.telegram).toEqual({ enabled: true });
  });

  it("does not report denied providers for disabled channels", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      channels: { telegram: { enabled: false } },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify(
        {
          channels: {
            denyRules: [
              {
                id: "no-telegram",
                when: { provider: "telegram" },
                reason: "Telegram is not approved for this workspace.",
              },
            ],
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    await expect(runDoctorLintChecks(ctx(configPath, cfg))).resolves.toMatchObject({
      findings: [],
    });
  });

  it("does not run channel checks for an empty category namespace", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      channels: { telegram: { enabled: true } },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ channels: {} }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([]);
  });
});
