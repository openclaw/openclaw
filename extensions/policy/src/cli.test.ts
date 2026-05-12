import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache } from "../../../src/config/config.js";
import { clearHealthChecksForTest } from "../../../src/flows/health-check-registry.js";
import { policyCheckCommand, policyWatchCommand } from "./cli.js";
import { resetPolicyDoctorChecksForTest } from "./doctor/register.js";
import {
  policyAttestationHash,
  policyWorkspaceHash,
  policyDocumentHash,
  policyFindingsHash,
} from "./policy-state.js";

let workspaceDir: string;

describe("policy commands", () => {
  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(join(tmpdir(), "policy-cli-"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    clearConfigCache();
    await fs.rm(workspaceDir, { recursive: true, force: true });
    clearHealthChecksForTest();
    resetPolicyDoctorChecksForTest();
  });

  it("checks policy rules and emits an attestation", async () => {
    const policy = {
      channels: {
        denyRules: [{ id: "no-telegram", when: { provider: "telegram" } }],
      },
    };
    await fs.writeFile(join(workspaceDir, "policy.jsonc"), JSON.stringify(policy), "utf-8");
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
    const parsed = JSON.parse(output.at(-1) ?? "{}");
    const policyHash = policyDocumentHash(policy);
    const evidence = { channels: [] };
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

    expect(exitCode).toBe(1);
    expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({
      ok: false,
      findings: [
        {
          checkId: "policy/policy-jsonc-invalid",
          target: "oc://policy.jsonc/channels/denyRules/#0",
        },
      ],
    });
  });

  it("links policy findings to both evidence and policy oc-paths", async () => {
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

    expect(exitCode).toBe(1);
    expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({
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

  it("reports stale accepted attestations in policy watch", async () => {
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
      }),
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ channels: { denyRules: [] } }),
      "utf-8",
    );
    const output: string[] = [];

    const exitCode = await policyWatchCommand(
      { cwd: workspaceDir, json: true, once: true },
      {
        writeStdout(value) {
          output.push(value);
        },
        error(value) {
          output.push(value);
        },
      },
    );

    const parsed = JSON.parse(output.at(-1) ?? "{}");
    expect(parsed).toMatchObject({
      status: "stale",
      expectedAttestationHash: "sha256:not-current",
      findings: [
        {
          checkId: "policy/attestation-hash-mismatch",
        },
      ],
    });
    expect(exitCode).toBe(1);
  });

  it("rejects invalid severity thresholds", async () => {
    await expect(
      policyCheckCommand(
        { cwd: workspaceDir, severityMin: "warnng" },
        {
          writeStdout() {},
          error() {},
        },
      ),
    ).rejects.toThrow("Invalid --severity-min value");
  });
});
