import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearConfigCache } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { policyCheckCommand, policyDiffCommand, policyWatchCommand } from "./cli.js";
import { resetPolicyDoctorChecksForTest } from "./doctor/register.js";
import {
  policyAttestationHash,
  policyWorkspaceHash,
  policyDocumentHash,
  policyFindingsHash,
} from "./policy-state.js";

let workspaceDir: string;

async function runPolicyCheckJson(options: Parameters<typeof policyCheckCommand>[0] = {}) {
  const output: string[] = [];
  const exitCode = await policyCheckCommand(
    { cwd: workspaceDir, json: true, ...options },
    {
      writeStdout(value) {
        output.push(value);
      },
      error(value) {
        output.push(value);
      },
    },
  );
  return { exitCode, parsed: JSON.parse(output.at(-1) ?? "{}"), output };
}

describe("policy commands", () => {
  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(join(tmpdir(), "policy-cli-"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    clearConfigCache();
    await fs.rm(workspaceDir, { recursive: true, force: true });
    resetPolicyDoctorChecksForTest();
  });

  it("checks policy rules and emits an attestation", async () => {
    const policy = {
      channels: {
        denyRules: [{ id: "no-telegram", when: { provider: "telegram" } }],
      },
    };
    await fs.writeFile(join(workspaceDir, "policy.jsonc"), JSON.stringify(policy), "utf-8");
    const { exitCode, parsed } = await runPolicyCheckJson();

    expect(exitCode).toBe(0);
    const policyHash = policyDocumentHash(policy);
    const evidence = {
      channels: [],
      channelRuntime: [],
      mcpServers: [],
      modelProviders: [],
      modelRefs: [],
      network: [],
    };
    const workspaceHash = policyWorkspaceHash(evidence);
    const findingsHash = policyFindingsHash([]);
    expect(typeof parsed.attestation.checkedAt).toBe("string");
    expect(parsed).toMatchObject({
      ok: true,
      attestation: {
        checkedAt: parsed.attestation.checkedAt,
        policy: {
          path: "policy.jsonc",
          hash: policyHash,
        },
        workspace: {
          scope: "policy",
          hash: workspaceHash,
        },
        findingsHash,
        attestationHash: policyAttestationHash({
          ok: true,
          policyHash,
          workspaceHash,
          findingsHash,
        }),
      },
      evidence,
      findings: [],
    });
  });

  it("reports policy findings in policy check output", async () => {
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        channels: {
          denyRules: [{ id: "no-telegram", when: { provider: "telegram" } }],
        },
      }),
      "utf-8",
    );
    const output: string[] = [];

    const exitCode = await policyCheckCommand(
      { cwd: workspaceDir, json: true },
      {
        writeStdout(value) {
          output.push(value);
        },
        error(value) {
          output.push(value);
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({
      ok: true,
      evidence: {
        channels: [],
        mcpServers: [],
        modelProviders: [],
        modelRefs: [],
        network: [],
      },
      findings: [],
    });
  });

  it("reports malformed policy rules in policy check output", async () => {
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ channels: { denyRules: [{ when: {} }] } }),
      "utf-8",
    );
    const { exitCode, parsed } = await runPolicyCheckJson();

    expect(exitCode).toBe(1);
    expect(parsed).toMatchObject({
      ok: false,
      findings: [
        {
          checkId: "policy/policy-jsonc-invalid",
          target: "oc://policy.jsonc/channels/denyRules/#0",
        },
      ],
    });
  });

  it("reports unparseable policy files in policy check output", async () => {
    await fs.writeFile(join(workspaceDir, "policy.jsonc"), "{ channels: ", "utf-8");
    const { exitCode, parsed } = await runPolicyCheckJson();

    expect(exitCode).toBe(1);
    expect(parsed).toMatchObject({
      ok: false,
      findings: [
        {
          checkId: "policy/policy-jsonc-invalid",
          severity: "error",
          target: "oc://policy.jsonc",
        },
      ],
    });
  });

  it("links policy findings to evidence and policy requirement refs", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    await fs.writeFile(
      configPath,
      JSON.stringify({
        plugins: {
          entries: {
            policy: { enabled: true, config: { enabled: true } },
          },
        },
        channels: { telegram: { enabled: true } },
      }),
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        channels: {
          denyRules: [{ id: "no-telegram", when: { provider: "telegram" } }],
        },
      }),
      "utf-8",
    );
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
        },
      ],
    });
  });

  it("attests underlying policy findings when the accepted attestation is stale", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    await fs.writeFile(
      configPath,
      JSON.stringify({
        plugins: {
          entries: {
            policy: {
              enabled: true,
              config: { enabled: true, expectedAttestationHash: "sha256:not-current" },
            },
          },
        },
        channels: { telegram: { enabled: true } },
      }),
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        channels: {
          denyRules: [{ id: "no-telegram", when: { provider: "telegram" } }],
        },
      }),
      "utf-8",
    );
    const { exitCode, parsed } = await runPolicyCheckJson();

    expect(exitCode).toBe(1);
    expect(parsed.findings).toEqual([
      expect.objectContaining({ checkId: "policy/attestation-hash-mismatch" }),
    ]);
    expect(parsed.attestation.findingsHash).not.toBe(policyFindingsHash([]));
    expect(parsed.attestation.attestationHash).toBe(
      policyAttestationHash({
        ok: false,
        policyHash: parsed.attestation.policy.hash,
        workspaceHash: parsed.attestation.workspace.hash,
        findingsHash: parsed.attestation.findingsHash,
      }),
    );
  });

  it("rejects invalid severity thresholds", async () => {
    const errors: string[] = [];

    const exitCode = await policyCheckCommand(
      { cwd: workspaceDir, severityMin: "warnng" },
      {
        writeStdout() {},
        error(value) {
          errors.push(value);
        },
      },
    );

    expect(exitCode).toBe(2);
    expect(errors).toEqual([
      "Invalid --severity-min value. Expected one of: info, warning, error.",
    ]);
  });

  it("fails closed when the OpenClaw config is invalid", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    await fs.writeFile(configPath, "{", "utf-8");
    const { exitCode, parsed } = await runPolicyCheckJson();

    expect(exitCode).toBe(1);
    expect(parsed.attestation).toBeUndefined();
    expect(parsed.findings).toEqual([
      expect.objectContaining({ checkId: "policy/config-invalid", severity: "error" }),
    ]);
  });

  it("compares policy check outputs without treating checkedAt as drift", async () => {
    const beforePath = join(workspaceDir, "before.json");
    const afterPath = join(workspaceDir, "after.json");
    const base = {
      ok: true,
      attestation: {
        checkedAt: "2026-05-10T20:00:00.000Z",
        policy: { path: "policy.jsonc", hash: "sha256:policy" },
        workspace: { scope: "policy", hash: "sha256:evidence" },
        findingsHash: "sha256:findings",
        attestationHash: "sha256:attestation",
      },
      findings: [],
    };
    await fs.writeFile(beforePath, JSON.stringify(base), "utf-8");
    await fs.writeFile(
      afterPath,
      JSON.stringify({
        ...base,
        attestation: {
          ...base.attestation,
          checkedAt: "2026-05-10T20:01:00.000Z",
        },
      }),
      "utf-8",
    );
    const output: string[] = [];

    const exitCode = await policyDiffCommand(
      beforePath,
      afterPath,
      { json: true },
      {
        writeStdout(value) {
          output.push(value);
        },
        error(value) {
          output.push(value);
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({
      changed: [],
      before: {
        checkedAt: "2026-05-10T20:00:00.000Z",
      },
      after: {
        checkedAt: "2026-05-10T20:01:00.000Z",
      },
    });
  });

  it("reports policy evidence drift between policy check outputs", async () => {
    const beforePath = join(workspaceDir, "before.json");
    const afterPath = join(workspaceDir, "after.json");
    await fs.writeFile(
      beforePath,
      JSON.stringify({
        ok: true,
        attestation: {
          workspace: { scope: "policy", hash: "sha256:evidence-before" },
          findingsHash: "sha256:findings",
          attestationHash: "sha256:attestation-before",
        },
      }),
      "utf-8",
    );
    await fs.writeFile(
      afterPath,
      JSON.stringify({
        ok: true,
        attestation: {
          workspace: { scope: "policy", hash: "sha256:evidence-after" },
          findingsHash: "sha256:findings",
          attestationHash: "sha256:attestation-after",
        },
      }),
      "utf-8",
    );
    const output: string[] = [];

    const exitCode = await policyDiffCommand(
      beforePath,
      afterPath,
      { json: true },
      {
        writeStdout(value) {
          output.push(value);
        },
        error(value) {
          output.push(value);
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({
      changed: ["evidence", "attestation"],
      before: {
        evidenceHash: "sha256:evidence-before",
      },
      after: {
        evidenceHash: "sha256:evidence-after",
      },
    });
  });
});
