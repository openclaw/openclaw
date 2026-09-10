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
      "tools rejects unknown root keys before malformed children",
      { tools: { unknown: true, profiles: null } },
      "tools/unknown",
      "tools.unknown is not supported in tools policy.",
      "Remove tools.unknown or use a supported tools policy rule.",
    ],
    [
      "tools checks all child containers before profile values",
      { tools: { profiles: { allow: ["unknown"] }, exec: false } },
      "tools/exec",
      "tools.exec must be an object.",
      "Fix policy.jsonc so tools.exec is an object.",
    ],
    [
      "tools checks profile values before later section keys",
      { tools: { profiles: { allow: ["unknown"] }, fs: { unknown: true } } },
      "tools/profiles/allow/#0",
      "tools.profiles.allow[0] must be a supported tool profile id.",
      "Use non-empty tool profile id entries. Supported values: minimal, coding, messaging, full.",
    ],
    [
      "tools exec checks security before ask mode",
      { tools: { exec: { requireAsk: ["unknown"], allowSecurity: ["unknown"] } } },
      "tools/exec/allowSecurity/#0",
      "tools.exec.allowSecurity[0] must be a supported exec security mode.",
      "Use non-empty exec security mode entries. Supported values: deny, allowlist, full.",
    ],
    [
      "scoped tools checks nested keys before child container types",
      {
        scopes: {
          release: { agentIds: ["release"], tools: { profiles: null, exec: { unknown: true } } },
        },
      },
      "scopes/release/tools/exec/unknown",
      "scopes.release.tools.exec.unknown is not supported in agent-scoped tools policy.",
      "Move scopes.release.tools.exec.unknown to top-level tools or use a supported scoped tools posture rule.",
    ],
    [
      "sandbox rejects unknown keys before malformed modes",
      { sandbox: { unknown: true, requireMode: null } },
      "sandbox/unknown",
      "sandbox.unknown is not supported in sandbox policy.",
      "Remove sandbox.unknown or use a supported sandbox posture rule.",
    ],
    [
      "sandbox checks modes before nested containers",
      { sandbox: { requireMode: ["unknown"], containers: null } },
      "sandbox/requireMode/#0",
      "sandbox.requireMode[0] must be a supported sandbox mode.",
      "Use non-empty sandbox mode entries. Supported values: off, non-main, all.",
    ],
    [
      "sandbox checks both child containers before their keys",
      { sandbox: { containers: { unknown: true }, browser: null } },
      "sandbox/browser",
      "sandbox.browser must be an object.",
      "Fix policy.jsonc so sandbox.browser is an object.",
    ],
    [
      "sandbox checks container values before browser keys",
      { sandbox: { containers: { denyHostNetwork: "yes" }, browser: { unknown: true } } },
      "sandbox/containers/denyHostNetwork",
      "sandbox.containers.denyHostNetwork must be a boolean.",
      "Set sandbox.containers.denyHostNetwork to true or false.",
    ],
    [
      "Gateway checks child containers before unknown root keys",
      { gateway: { unknown: true, auth: false } },
      "gateway/auth",
      "gateway.auth must be an object.",
      "Fix policy.jsonc so gateway.auth is an object.",
    ],
    [
      "Gateway checks all child keys before boolean values",
      { gateway: { exposure: { allowNonLoopbackBind: "no" }, nodes: { unknown: true } } },
      "gateway/nodes/unknown",
      "gateway.nodes.unknown is not supported in Gateway policy.",
      "Remove gateway.nodes.unknown or use a supported Gateway policy rule.",
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
      "workspace tool ids trim whitespace but retain case",
      { agents: { workspace: { denyTools: [" exec ", "PROCESS"] } } },
      "agents/workspace/denyTools/#1",
      "agents.workspace.denyTools[1] must be a supported agent workspace tool id.",
      "Use supported tool ids: exec, process, write, edit, apply_patch.",
    ],
    [
      "endpoint list type errors retain their repair hint",
      { gateway: { http: { denyEndpoints: "responses" } } },
      "gateway/http/denyEndpoints",
      "gateway.http.denyEndpoints must be an array.",
      'Use an array of endpoint ids such as ["responses"] or remove gateway.http.denyEndpoints.',
    ],
    [
      "node command lists report the first blank entry",
      { gateway: { nodes: { denyCommands: [" system.run ", " ", null] } } },
      "gateway/nodes/denyCommands/#1",
      "gateway.nodes.denyCommands[1] must be a non-empty node command id.",
      "Use non-empty node command ids.",
    ],
  ] as const)("%s", (_name, policy, target, message, fixHint) => {
    expectInvalid(policy, target, message, fixHint);
    expectInvalid(reverseObjectKeys(policy), target, message, fixHint);
  });

  it.each([
    [{ tools: { "later.key": true, "first/key": true } }, 'tools/"later.key"', "tools.later.key"],
    [{ tools: { "first/key": true, "later.key": true } }, 'tools/"first/key"', "tools.first/key"],
  ] as const)("reports the first authored unsupported key in %j", (policy, target, property) => {
    expectInvalid(
      policy,
      target,
      `${property} is not supported in tools policy.`,
      `Remove ${property} or use a supported tools policy rule.`,
    );
  });

  it.each(["tools", "sandbox", "gateway", "agents"])(
    "rejects an explicit null %s container",
    (section) => {
      expectInvalid(
        { [section]: null },
        section,
        `${section} must be an object.`,
        `Fix policy.jsonc so ${section} is an object.`,
      );
    },
  );

  it.each([
    ["omitted sections", {}],
    [
      "undefined sections",
      { tools: undefined, sandbox: undefined, gateway: undefined, agents: undefined },
    ],
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
    [
      "trimmed enum and free-form list entries",
      {
        agents: { workspace: { allowedAccess: ["ro"], denyTools: [" exec "] } },
        tools: {
          profiles: { allow: [" coding "] },
          exec: {
            allowHosts: [" sandbox "],
            requireAsk: [" always "],
            allowSecurity: [" allowlist "],
          },
        },
        sandbox: { requireMode: [" all "], allowBackends: [" docker "] },
        gateway: {
          http: { denyEndpoints: [" responses "] },
          nodes: { denyCommands: [" system.run "] },
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

  it.each([
    ["", 'scopes/""'],
    ['team/"blue', 'scopes/"team/\\"blue"'],
  ])("retains custom document and escaped scope targets for %j", (scopeName, targetPrefix) => {
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
  });
});
