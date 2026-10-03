import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PolicyEvidence, PolicySandboxPostureEvidence } from "../policy-state.js";
import { evaluatePolicy } from "./evaluation.js";
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
function sandboxEntry(
  kind: "mode" | "backend",
  value: string,
  agentId?: string,
): PolicySandboxPostureEvidence {
  return {
    id: `${agentId ?? "agents-defaults"}-${kind}`,
    kind,
    source: `oc://openclaw.config/agents/${agentId ? `entries/${agentId}` : "defaults"}/sandbox/${kind}`,
    scope: agentId ? "agent" : "defaults",
    ...(agentId === undefined ? {} : { agentId }),
    value,
    explicit: true,
  };
}
const posture = [
  sandboxEntry("backend", "SSH", "alpha"),
  sandboxEntry("mode", "OFF"),
  sandboxEntry("mode", "off", "alpha"),
  sandboxEntry("backend", "ssh"),
  sandboxEntry("mode", "all", "beta"),
  sandboxEntry("backend", "docker", "beta"),
] as const;
const evidence: PolicyEvidence = {
  channels: [],
  mcpServers: [],
  modelProviders: [],
  modelRefs: [],
  network: [],
  sandboxPosture: posture,
};
const defaultMode = {
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
};
const alphaMode = {
  ...defaultMode,
  ocPath: "oc://openclaw.config/agents/entries/alpha/sandbox/mode",
  target: "oc://openclaw.config/agents/entries/alpha/sandbox/mode",
  message: "agent 'alpha' uses unapproved sandbox mode 'off'.",
};
const defaultBackend = {
  ...defaultMode,
  checkId: "policy/sandbox-backend-unapproved",
  ocPath: "oc://openclaw.config/agents/defaults/sandbox/backend",
  target: "oc://openclaw.config/agents/defaults/sandbox/backend",
  message: "default sandbox config uses unapproved sandbox backend 'ssh'.",
  requirement: "oc://policy.jsonc/sandbox/allowBackends",
  fixHint: "Use an approved sandbox backend or update policy after review.",
};
const alphaBackend = {
  ...defaultBackend,
  ocPath: "oc://openclaw.config/agents/entries/alpha/sandbox/backend",
  target: "oc://openclaw.config/agents/entries/alpha/sandbox/backend",
  message: "agent 'alpha' uses unapproved sandbox backend 'SSH'.",
};

function findings(rules: unknown, observed: PolicyEvidence = evidence) {
  return sandboxPostureFindings(rules, "policy.jsonc", "policy.jsonc", observed);
}

describe("sandbox allowlist finding order", () => {
  it("disables the empty mode allowlist without disabling the backend allowlist", () => {
    expect(findings({ sandbox: { requireMode: [], allowBackends: ["docker"] } })).toEqual([
      alphaBackend,
      defaultBackend,
    ]);
  });

  it("retains ordered inherited-default findings for a matching scope", () => {
    expect(
      findings(policy, {
        ...evidence,
        sandboxPosture: [posture[1], posture[3], posture[4], posture[5]],
      }),
    ).toEqual([
      defaultMode,
      defaultBackend,
      { ...defaultMode, requirement: "oc://policy.jsonc/scopes/release/sandbox/requireMode" },
      { ...defaultBackend, requirement: "oc://policy.jsonc/scopes/release/sandbox/allowBackends" },
    ]);
  });
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
      { ...defaultMode, message: "default sandbox config uses unapproved sandbox mode 'off'." },
      alphaMode,
      defaultBackend,
      { ...alphaBackend, message: "agent 'alpha' uses unapproved sandbox backend 'ssh'." },
      { ...alphaMode, requirement: "oc://policy.jsonc/scopes/release/sandbox/requireMode" },
      {
        ...alphaBackend,
        message: "agent 'alpha' uses unapproved sandbox backend 'ssh'.",
        requirement: "oc://policy.jsonc/scopes/release/sandbox/allowBackends",
      },
    ]);
  });
});
