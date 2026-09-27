import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PolicyEvidence } from "../policy-state.js";
import { evaluatePolicy } from "./evaluation.js";
import { posturePolicyShapeFinding } from "./posture-shapes.js";
import {
  cfgWithPolicyOverrides,
  ctx,
  setupPolicyDoctorTest,
  teardownPolicyDoctorTest,
  writePolicyFixture,
} from "./register.test-harness.js";
import { sandboxPostureFindings } from "./sandbox-findings.js";

const policy = {
  sandbox: {
    requireMode: ["all"],
    allowBackends: ["docker"],
  },
  scopes: {
    release: {
      agentIds: ["ALPHA"],
      sandbox: {
        requireMode: ["all"],
        allowBackends: ["docker"],
      },
    },
  },
};
const posture = [
  {
    id: "alpha-backend",
    kind: "backend",
    source: "oc://openclaw.config/agents/entries/alpha/sandbox/backend",
    scope: "agent",
    agentId: "alpha",
    value: "SSH",
    explicit: true,
  },
  {
    id: "agents-defaults-mode",
    kind: "mode",
    source: "oc://openclaw.config/agents/defaults/sandbox/mode",
    scope: "defaults",
    value: "OFF",
    explicit: true,
  },
  {
    id: "alpha-mode",
    kind: "mode",
    source: "oc://openclaw.config/agents/entries/alpha/sandbox/mode",
    scope: "agent",
    agentId: "alpha",
    value: "off",
    explicit: true,
  },
  {
    id: "agents-defaults-backend",
    kind: "backend",
    source: "oc://openclaw.config/agents/defaults/sandbox/backend",
    scope: "defaults",
    value: "ssh",
    explicit: true,
  },
  {
    id: "beta-mode",
    kind: "mode",
    source: "oc://openclaw.config/agents/entries/beta/sandbox/mode",
    scope: "agent",
    agentId: "beta",
    value: "all",
    explicit: true,
  },
  {
    id: "beta-backend",
    kind: "backend",
    source: "oc://openclaw.config/agents/entries/beta/sandbox/backend",
    scope: "agent",
    agentId: "beta",
    value: "docker",
    explicit: true,
  },
] as const;
const evidence: PolicyEvidence = {
  channels: [],
  mcpServers: [],
  modelProviders: [],
  modelRefs: [],
  network: [],
  sandboxPosture: posture,
};
const expected = [
  {
    checkId: "policy/sandbox-mode-unapproved",
    severity: "error",
    source: "policy",
    path: "openclaw config",
    ocPath: "oc://openclaw.config/agents/defaults/sandbox/mode",
    target: "oc://openclaw.config/agents/defaults/sandbox/mode",
    message: "default sandbox config uses unapproved sandbox mode 'OFF'.",
    requirement: "oc://policy.jsonc/sandbox/requireMode",
    fixHint:
      "Set agents.defaults.sandbox.mode or agents.entries.<id>.sandbox.mode to an approved value.",
  },
  {
    checkId: "policy/sandbox-mode-unapproved",
    severity: "error",
    source: "policy",
    path: "openclaw config",
    ocPath: "oc://openclaw.config/agents/entries/alpha/sandbox/mode",
    target: "oc://openclaw.config/agents/entries/alpha/sandbox/mode",
    message: "agent 'alpha' uses unapproved sandbox mode 'off'.",
    requirement: "oc://policy.jsonc/sandbox/requireMode",
    fixHint:
      "Set agents.defaults.sandbox.mode or agents.entries.<id>.sandbox.mode to an approved value.",
  },
  {
    checkId: "policy/sandbox-backend-unapproved",
    severity: "error",
    source: "policy",
    path: "openclaw config",
    ocPath: "oc://openclaw.config/agents/entries/alpha/sandbox/backend",
    target: "oc://openclaw.config/agents/entries/alpha/sandbox/backend",
    message: "agent 'alpha' uses unapproved sandbox backend 'SSH'.",
    requirement: "oc://policy.jsonc/sandbox/allowBackends",
    fixHint: "Use an approved sandbox backend or update policy after review.",
  },
  {
    checkId: "policy/sandbox-backend-unapproved",
    severity: "error",
    source: "policy",
    path: "openclaw config",
    ocPath: "oc://openclaw.config/agents/defaults/sandbox/backend",
    target: "oc://openclaw.config/agents/defaults/sandbox/backend",
    message: "default sandbox config uses unapproved sandbox backend 'ssh'.",
    requirement: "oc://policy.jsonc/sandbox/allowBackends",
    fixHint: "Use an approved sandbox backend or update policy after review.",
  },
  {
    checkId: "policy/sandbox-mode-unapproved",
    severity: "error",
    source: "policy",
    path: "openclaw config",
    ocPath: "oc://openclaw.config/agents/entries/alpha/sandbox/mode",
    target: "oc://openclaw.config/agents/entries/alpha/sandbox/mode",
    message: "agent 'alpha' uses unapproved sandbox mode 'off'.",
    requirement: "oc://policy.jsonc/scopes/release/sandbox/requireMode",
    fixHint:
      "Set agents.defaults.sandbox.mode or agents.entries.<id>.sandbox.mode to an approved value.",
  },
  {
    checkId: "policy/sandbox-backend-unapproved",
    severity: "error",
    source: "policy",
    path: "openclaw config",
    ocPath: "oc://openclaw.config/agents/entries/alpha/sandbox/backend",
    target: "oc://openclaw.config/agents/entries/alpha/sandbox/backend",
    message: "agent 'alpha' uses unapproved sandbox backend 'SSH'.",
    requirement: "oc://policy.jsonc/scopes/release/sandbox/allowBackends",
    fixHint: "Use an approved sandbox backend or update policy after review.",
  },
] as const;

function findings(rules: unknown, observed: PolicyEvidence = evidence) {
  return sandboxPostureFindings(rules, "policy.jsonc", "policy.jsonc", observed);
}

describe("sandbox allowlist finding order", () => {
  it("keeps mode before backend and global before scoped findings with all provenance", () => {
    expect(findings(policy)).toEqual(expected);
  });

  it.each([
    {
      name: "omitted mode",
      sandbox: { allowBackends: ["docker"] },
      expected: [expected[2], expected[3]],
    },
    {
      name: "empty mode",
      sandbox: { requireMode: [], allowBackends: ["docker"] },
      expected: [expected[2], expected[3]],
    },
    {
      name: "omitted backend",
      sandbox: { requireMode: ["all"] },
      expected: [expected[0], expected[1]],
    },
    {
      name: "empty backend",
      sandbox: { requireMode: ["all"], allowBackends: [] },
      expected: [expected[0], expected[1]],
    },
    { name: "both omitted", sandbox: {}, expected: [] },
    { name: "both empty", sandbox: { requireMode: [], allowBackends: [] }, expected: [] },
  ])("disables only the $name allowlist", ({ sandbox, expected: ordered }) => {
    expect(findings({ sandbox })).toEqual(ordered);
  });

  it("accepts padded policy values and case-folds observed strings", () => {
    expect(
      findings(
        { sandbox: { requireMode: [" all "], allowBackends: [" DoCkEr "] } },
        {
          ...evidence,
          sandboxPosture: posture.map((entry) => ({
            ...entry,
            value: entry.kind === "mode" ? "ALL" : "DOCKER",
          })),
        },
      ),
    ).toEqual([]);
  });

  it("ignores missing and boolean evidence values", () => {
    const missing = posture.map(({ value: _value, ...entry }) => entry);
    expect(findings(policy, { ...evidence, sandboxPosture: missing })).toEqual([]);
    expect(
      findings(policy, {
        ...evidence,
        sandboxPosture: posture.map((entry) => ({ ...entry, value: false })),
      }),
    ).toEqual([]);
  });

  it("accepts absent and empty sandbox evidence", () => {
    const { sandboxPosture: _posture, ...withoutPosture } = evidence;
    expect(findings(policy, withoutPosture)).toEqual([]);
    expect(findings(policy, { ...evidence, sandboxPosture: [] })).toEqual([]);
  });

  it("retains ordered inherited-default findings for a matching scope", () => {
    expect(
      findings(policy, {
        ...evidence,
        sandboxPosture: [posture[1], posture[3], posture[4], posture[5]],
      }),
    ).toEqual([
      expected[0],
      expected[3],
      { ...expected[0], requirement: "oc://policy.jsonc/scopes/release/sandbox/requireMode" },
      { ...expected[3], requirement: "oc://policy.jsonc/scopes/release/sandbox/allowBackends" },
    ]);
  });

  it.each([{ requireMode: ["ALL"] }, { requireMode: [" "] }, { allowBackends: [" "] }])(
    "keeps invalid policy allowlists as shape errors: %j",
    (sandbox) => {
      expect(
        posturePolicyShapeFinding("sandbox", sandbox, {
          policyDocName: "policy.jsonc",
          policyPath: "policy.jsonc",
        }),
      ).toBeDefined();
    },
  );
});

describe("sandbox allowlists in policy evaluation", () => {
  beforeEach(setupPolicyDoctorTest);
  afterEach(teardownPolicyDoctorTest);

  it("preserves the complete ordered attested findings for keyed agents and scopes", async () => {
    const configPath = await writePolicyFixture(policy);
    const cfg = cfgWithPolicyOverrides({
      agents: {
        defaults: { sandbox: { mode: "off", backend: "ssh" } },
        entries: {
          alpha: { sandbox: { mode: "off", backend: "ssh" } },
          beta: { sandbox: { mode: "all", backend: "docker" } },
        },
      },
    });
    const result = await evaluatePolicy(ctx(configPath, cfg));
    expect(result.attestedFindings).toEqual([
      { ...expected[0], message: "default sandbox config uses unapproved sandbox mode 'off'." },
      expected[1],
      expected[3],
      { ...expected[2], message: "agent 'alpha' uses unapproved sandbox backend 'ssh'." },
      expected[4],
      { ...expected[5], message: "agent 'alpha' uses unapproved sandbox backend 'ssh'." },
    ]);
  });
});
