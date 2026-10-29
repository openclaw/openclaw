import { describe, expect, it } from "vitest";
import { policyContainerShapeFindings } from "./policy-shape.js";

function reverseObjectKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Array.isArray(value)
    ? value.map(reverseObjectKeys)
    : Object.fromEntries(
        Object.entries(value)
          .toReversed()
          .map(([key, entry]) => [key, reverseObjectKeys(entry)]),
      );
}

describe("policy container diagnostics", () => {
  it.each<[string, string, string, string?, string?, string?]>([
    [
      "sandbox checks both child containers before their keys",
      '{"sandbox":{"containers":{"unknown":true},"browser":null}}',
      "sandbox/browser",
    ],
    [
      "Gateway checks boolean values before endpoint lists",
      '{"gateway":{"http":{"denyEndpoints":["unknown"]},"auth":{"requireAuth":"yes"}}}',
      "gateway/auth/requireAuth",
    ],
    [
      "workspace checks raw access values before tool ids",
      '{"agents":{"workspace":{"allowedAccess":[" ro "],"denyTools":["unknown"]}}}',
      "agents/workspace/allowedAccess/#0",
    ],
    [
      "endpoint list type errors retain their repair hint",
      '{"gateway":{"http":{"denyEndpoints":"responses"}}}',
      "gateway/http/denyEndpoints",
      'Use an array of endpoint ids such as ["responses"] or remove gateway.http.denyEndpoints.',
    ],
    [
      "rejects scoped metadata before malformed children",
      '{"scopes":{"release":{"agentIds":["release"],"tools":{"profiles":null,"requireMetadata":["owner"]}}}}',
      "scopes/release/tools/requireMetadata",
    ],
    [
      "retains custom document and escaped scope targets",
      JSON.stringify({
        scopes: { 'team/"blue': { agentIds: ["release"], sandbox: { requireMode: ["ALL"] } } },
      }),
      'scopes/"team/\\"blue"/sandbox/requireMode/#0',
      undefined,
      "policies/release.jsonc",
      "release.policy.jsonc",
    ],
  ])("%s", (_name, json, target, fixHint, path = "policy.jsonc", document = path) => {
    const policy: unknown = JSON.parse(json);
    const expected = [
      expect.objectContaining({
        checkId: "policy/policy-jsonc-invalid",
        severity: "error",
        path,
        target: `oc://${document}/${target}`,
        ...(fixHint === undefined ? {} : { fixHint }),
      }),
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
