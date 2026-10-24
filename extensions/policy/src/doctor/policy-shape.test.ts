import { describe, expect, it } from "vitest";
import { policyContainerShapeFindings } from "./policy-shape.js";

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
  it.each<[string, string, string, string, string, string?, string?]>([
    [
      "sandbox checks both child containers before their keys",
      '{"sandbox":{"containers":{"unknown":true},"browser":null}}',
      "sandbox/browser",
      "sandbox.browser must be an object.",
      "Fix policy.jsonc so sandbox.browser is an object.",
    ],
    [
      "Gateway checks boolean values before endpoint lists",
      '{"gateway":{"http":{"denyEndpoints":["unknown"]},"auth":{"requireAuth":"yes"}}}',
      "gateway/auth/requireAuth",
      "gateway.auth.requireAuth must be a boolean.",
      "Fix policy.jsonc so gateway.auth.requireAuth is true or false.",
    ],
    [
      "workspace checks raw access values before tool ids",
      '{"agents":{"workspace":{"allowedAccess":[" ro "],"denyTools":["unknown"]}}}',
      "agents/workspace/allowedAccess/#0",
      "agents.workspace.allowedAccess[0] must be none, ro, or rw.",
      'Use workspace access values such as ["none", "ro"].',
    ],
    [
      "endpoint list type errors retain their repair hint",
      '{"gateway":{"http":{"denyEndpoints":"responses"}}}',
      "gateway/http/denyEndpoints",
      "gateway.http.denyEndpoints must be an array.",
      'Use an array of endpoint ids such as ["responses"] or remove gateway.http.denyEndpoints.',
    ],
    [
      "rejects scoped metadata before malformed children",
      '{"scopes":{"release":{"agentIds":["release"],"tools":{"profiles":null,"requireMetadata":["owner"]}}}}',
      "scopes/release/tools/requireMetadata",
      "scopes.release.tools.requireMetadata is not supported in agent-scoped tools policy.",
      "Move scopes.release.tools.requireMetadata to top-level tools or use a supported scoped tools posture rule.",
    ],
    [
      "retains custom document and escaped scope targets",
      JSON.stringify({
        scopes: { 'team/"blue': { agentIds: ["release"], sandbox: { requireMode: ["ALL"] } } },
      }),
      'scopes/"team/\\"blue"/sandbox/requireMode/#0',
      'scopes.team/"blue.sandbox.requireMode[0] must be a supported sandbox mode.',
      "Use non-empty sandbox mode entries. Supported values: off, non-main, all.",
      "policies/release.jsonc",
      "release.policy.jsonc",
    ],
  ])("%s", (_name, json, target, message, fixHint, path = "policy.jsonc", document = path) => {
    const policy: unknown = JSON.parse(json);
    const expected = [
      {
        checkId: "policy/policy-jsonc-invalid",
        severity: "error",
        source: "policy",
        path,
        target: `oc://${document}/${target}`,
        message: `${path} ${message}`,
        fixHint,
      },
    ];
    expect(policyContainerShapeFindings(policy, path, document)).toEqual(expected);
    expect(policyContainerShapeFindings(reverseObjectKeys(policy), path, document)).toEqual(
      expected,
    );
  });

  it.each([
    [
      "empty containers and lists",
      `{
      "agents": {"workspace": {"allowedAccess": [], "denyTools": []}},
      "tools": {"profiles": {"allow": []}, "exec": {}, "fs": {}, "elevated": {}, "alsoAllow": {"expected": []}, "denyTools": []},
      "sandbox": {"requireMode": [], "allowBackends": [], "containers": {}, "browser": {}},
      "gateway": {"exposure": {}, "auth": {}, "controlUi": {}, "remote": {}, "http": {"denyEndpoints": []}, "nodes": {"denyCommands": []}},
      "scopes": {"": {"agentIds": ["release"], "tools": {}, "agents": {"workspace": {}}, "sandbox": {}}}
    }`,
    ],
    ["deferred global metadata values", '{"tools":{"requireMetadata":["unknown"]}}'],
  ] as const)("accepts %s", (_name, json) => {
    expect(policyContainerShapeFindings(JSON.parse(json), "policy.jsonc", "policy.jsonc")).toEqual(
      [],
    );
  });
});
