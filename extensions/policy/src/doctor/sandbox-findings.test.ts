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

const sandbox = { requireMode: ["all"], allowBackends: ["docker"] };
const policy = { sandbox, scopes: { release: { agentIds: ["ALPHA"], sandbox } } };
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
function receipt(kind: "mode" | "backend", value: string, agentId?: string, scoped = false) {
  const target = `oc://openclaw.config/agents/${agentId ? `entries/${agentId}` : "defaults"}/sandbox/${kind}`;
  return expect.objectContaining({
    checkId: `policy/sandbox-${kind}-unapproved`,
    severity: "error",
    ocPath: target,
    target,
    message: `${agentId ? `agent '${agentId}'` : "default sandbox config"} uses unapproved sandbox ${kind} '${value}'.`,
    requirement: `oc://policy.jsonc/${scoped ? "scopes/release/" : ""}sandbox/${kind === "mode" ? "requireMode" : "allowBackends"}`,
  });
}
const defaultMode = receipt("mode", "OFF");
const alphaMode = receipt("mode", "off", "alpha");
const defaultBackend = receipt("backend", "ssh");
const alphaBackend = receipt("backend", "SSH", "alpha");

function findings(rules: unknown, observed: PolicyEvidence = evidence) {
  return sandboxPostureFindings(rules, "policy.jsonc", "policy.jsonc", observed);
}

describe("sandbox allowlist finding order", () => {
  it.each<[string, unknown, ReturnType<typeof receipt>[]]>([
    ["empty mode", { requireMode: [], allowBackends: ["docker"] }, [alphaBackend, defaultBackend]],
    ["omitted backend", { requireMode: ["all"] }, [defaultMode, alphaMode]],
  ])("disables only the %s allowlist", (_name, rules, ordered) => {
    expect(findings({ sandbox: rules })).toEqual(ordered);
  });

  it("accepts padded policy values and case-folds observed strings", () => {
    const allowed = { sandbox: { requireMode: [" all "], allowBackends: [" DoCkEr "] } };
    const sandboxPosture = posture.map((entry) => ({
      ...entry,
      value: entry.kind === "mode" ? "ALL" : "DOCKER",
    }));
    expect(findings(allowed, { ...evidence, sandboxPosture })).toEqual([]);
  });

  it("accepts absent and empty sandbox evidence", () => {
    const { sandboxPosture: _posture, ...withoutPosture } = evidence;
    expect(findings(policy, withoutPosture)).toEqual([]);
    expect(findings(policy, { ...evidence, sandboxPosture: [] })).toEqual([]);
  });

  it("retains ordered inherited-default findings for a matching scope", () => {
    const sandboxPosture = [posture[1], posture[3], posture[4], posture[5]];
    expect(findings(policy, { ...evidence, sandboxPosture })).toEqual([
      defaultMode,
      defaultBackend,
      receipt("mode", "OFF", undefined, true),
      receipt("backend", "ssh", undefined, true),
    ]);
  });
});

describe("sandbox allowlists in policy evaluation", () => {
  beforeEach(setupPolicyDoctorTest);
  afterEach(teardownPolicyDoctorTest);

  it("preserves the complete ordered attested findings for keyed agents and scopes", async () => {
    const rejected = { sandbox: { mode: "off", backend: "ssh" } } as const;
    const cfg = cfgWithPolicyOverrides({
      agents: {
        defaults: rejected,
        entries: {
          alpha: rejected,
          beta: { sandbox: { mode: "all", backend: "docker" } },
        },
      },
    });
    const result = await evaluatePolicy(ctx(await writePolicyFixture(policy), cfg));
    expect(result.attestedFindings).toEqual([
      receipt("mode", "off"),
      alphaMode,
      defaultBackend,
      receipt("backend", "ssh", "alpha"),
      receipt("mode", "off", "alpha", true),
      receipt("backend", "ssh", "alpha", true),
    ]);
  });
});
