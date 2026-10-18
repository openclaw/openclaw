import { describe, expect, it } from "vitest";
import { policyContainerShapeFindings } from "./policy-shape.js";

const policyPath = "policy.jsonc";

function expectInvalid(policy: unknown, target: string, message: string, fixHint: string) {
  expect(policyContainerShapeFindings(policy, policyPath, policyPath)).toEqual([
    {
      checkId: "policy/policy-jsonc-invalid",
      severity: "error",
      source: "policy",
      path: policyPath,
      target: `oc://${policyPath}/${target}`,
      message: `${policyPath} ${message}`,
      fixHint,
    },
  ]);
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(reverseObjectKeys);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .toReversed()
      .map(([key, entry]) => [key, reverseObjectKeys(entry)]),
  );
}

describe("policy container diagnostics", () => {
  it.each([
    [
      "sandbox checks both child containers before their keys",
      { sandbox: { containers: { unknown: true }, browser: null } },
      "sandbox/browser",
      "sandbox.browser must be an object.",
      "Fix policy.jsonc so sandbox.browser is an object.",
    ],
    [
      "Gateway checks boolean values before endpoint lists",
      { gateway: { http: { denyEndpoints: ["unknown"] }, auth: { requireAuth: "yes" } } },
      "gateway/auth/requireAuth",
      "gateway.auth.requireAuth must be a boolean.",
      "Fix policy.jsonc so gateway.auth.requireAuth is true or false.",
    ],
    [
      "workspace checks raw access values before tool ids",
      { agents: { workspace: { allowedAccess: [" ro "], denyTools: ["unknown"] } } },
      "agents/workspace/allowedAccess/#0",
      "agents.workspace.allowedAccess[0] must be none, ro, or rw.",
      'Use workspace access values such as ["none", "ro"].',
    ],
    [
      "endpoint list type errors retain their repair hint",
      { gateway: { http: { denyEndpoints: "responses" } } },
      "gateway/http/denyEndpoints",
      "gateway.http.denyEndpoints must be an array.",
      'Use an array of endpoint ids such as ["responses"] or remove gateway.http.denyEndpoints.',
    ],
  ] as const)("%s", (_name, policy, target, message, fixHint) => {
    expectInvalid(policy, target, message, fixHint);
    expectInvalid(reverseObjectKeys(policy), target, message, fixHint);
  });

  it.each([
    [
      "empty containers and lists",
      {
        agents: { workspace: { allowedAccess: [], denyTools: [] } },
        tools: {
          profiles: { allow: [] },
          exec: {},
          fs: {},
          elevated: {},
          alsoAllow: { expected: [] },
          denyTools: [],
        },
        sandbox: { requireMode: [], allowBackends: [], containers: {}, browser: {} },
        gateway: {
          exposure: {},
          auth: {},
          controlUi: {},
          remote: {},
          http: { denyEndpoints: [] },
          nodes: { denyCommands: [] },
        },
        scopes: {
          "": { agentIds: ["release"], tools: {}, agents: { workspace: {} }, sandbox: {} },
        },
      },
    ],
  ] as const)("accepts %s", (_name, policy) => {
    expect(policyContainerShapeFindings(policy, policyPath, policyPath)).toEqual([]);
  });

  it("defers global metadata values while rejecting scoped metadata before malformed children", () => {
    expect(
      policyContainerShapeFindings(
        { tools: { requireMetadata: ["unknown"] } },
        policyPath,
        policyPath,
      ),
    ).toEqual([]);
    expectInvalid(
      {
        scopes: {
          release: { agentIds: ["release"], tools: { profiles: null, requireMetadata: ["owner"] } },
        },
      },
      "scopes/release/tools/requireMetadata",
      "scopes.release.tools.requireMetadata is not supported in agent-scoped tools policy.",
      "Move scopes.release.tools.requireMetadata to top-level tools or use a supported scoped tools posture rule.",
    );
  });

  it.each([['team/"blue', 'scopes/"team/\\"blue"']])(
    "retains custom document and escaped scope targets for %j",
    (scopeName, targetPrefix) => {
      expect(
        policyContainerShapeFindings(
          { scopes: { [scopeName]: { agentIds: ["release"], sandbox: { requireMode: ["ALL"] } } } },
          "policies/release.jsonc",
          "release.policy.jsonc",
        ),
      ).toEqual([
        {
          checkId: "policy/policy-jsonc-invalid",
          severity: "error",
          source: "policy",
          path: "policies/release.jsonc",
          target: `oc://release.policy.jsonc/${targetPrefix}/sandbox/requireMode/#0`,
          message: `policies/release.jsonc scopes.${scopeName}.sandbox.requireMode[0] must be a supported sandbox mode.`,
          fixHint: "Use non-empty sandbox mode entries. Supported values: off, non-main, all.",
        },
      ]);
    },
  );
});
