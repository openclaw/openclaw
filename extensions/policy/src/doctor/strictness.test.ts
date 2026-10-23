import { describe, expect, it } from "vitest";
import { POLICY_RULE_METADATA } from "./metadata.js";
import { isPolicyValueAtLeastAsStrict } from "./strictness.js";

function compare(path: string) {
  const rule = POLICY_RULE_METADATA.find((entry) => entry.policyPath.join(".") === path);
  expect(rule).toBeDefined();
  return (candidate: unknown, baseline: unknown, expected: boolean) => {
    expect(isPolicyValueAtLeastAsStrict(rule!, candidate, baseline)).toBe(expected);
  };
}

const prod = { pattern: "deploy", argPattern: "^--prod$" };

describe("policy doctor strictness", () => {
  it.each<[string, unknown, unknown, boolean]>([
    ["normalizes string and object requirements", [" deploy "], [{ pattern: "deploy" }], true],
    [
      "trims argument constraints",
      [{ pattern: " deploy ", argPattern: " ^--prod$ " }],
      [prod],
      true,
    ],
    ["treats blank optional arguments as absent", [{ ...prod, argPattern: " " }], ["deploy"], true],
    ["ignores list order", ["status", "deploy", "deploy"], ["deploy", "status", "deploy"], true],
    ["preserves duplicate cardinality", ["deploy", "deploy"], ["deploy"], false],
    ["rejects a removed argument constraint", ["deploy"], [prod], false],
    ["preserves pattern case", ["Deploy"], ["deploy"], false],
    [
      "preserves argument pattern case",
      [{ pattern: "deploy", argPattern: "^--PROD$" }],
      [prod],
      false,
    ],
    ["accepts matching empty requirements", [], [], true],
    ["keeps empty requirements meaningful", [], ["deploy"], false],
    ["rejects blank entries instead of dropping them", ["deploy", " "], ["deploy"], false],
    [
      "rejects unsupported requirement keys",
      [{ pattern: "deploy", argpattern: "^--prod$" }],
      ["deploy"],
      false,
    ],
    ["rejects null argument constraints", [{ ...prod, argPattern: null }], ["deploy"], false],
    ["rejects missing patterns", [{ argPattern: "^--prod$" }], [], false],
    ["rejects non-array requirements", {}, [], false],
  ])("exec approval requirements: %s", (_name, candidate, baseline, expected) => {
    const check = compare("execApprovals.agents.allowlist.expected");
    check(candidate, baseline, expected);
    check(baseline, candidate, expected);
  });

  it("compares policy values through strictness metadata", () => {
    const allowHosts = compare("tools.exec.allowHosts");
    const denyTools = compare("tools.denyTools");
    const denyNodeCommands = compare("gateway.nodes.denyCommands");
    const fsWorkspaceOnly = compare("tools.fs.requireWorkspaceOnly");
    const denyHostNetwork = compare("sandbox.containers.denyHostNetwork");
    const alsoAllow = compare("tools.alsoAllow.expected");
    const routingProbes = compare("routing.probes");
    allowHosts(["sandbox"], ["sandbox", "node"], true);
    allowHosts(["sandbox", "node"], ["sandbox"], false);
    allowHosts([], ["sandbox"], false);
    allowHosts(["sandbox"], [], true);
    denyTools(["exec", "write"], ["exec"], true);
    denyTools(["write"], ["exec"], false);
    denyTools(["group:runtime"], ["exec"], true);
    denyTools(["exec"], ["group:runtime"], false);
    denyNodeCommands(["system.run"], ["system.run"], true);
    denyNodeCommands([], ["system.run"], false);
    denyNodeCommands(["system.Run"], ["system.run"], false);
    denyHostNetwork(true, true, true);
    denyHostNetwork(false, true, false);
    fsWorkspaceOnly(true, true, true);
    fsWorkspaceOnly(false, true, false);
    alsoAllow(["read"], ["read"], true);
    alsoAllow([], ["read"], false);
    const baselineProbe = {
      id: "family-dm",
      route: { channel: "imessage", peer: { kind: "direct", id: "private" } },
      expect: { agentId: "family", matchedBy: ["binding.peer", "binding.account"] },
    };
    const withExpectation = (overrides: Partial<typeof baselineProbe.expect>) => [
      { ...baselineProbe, expect: { ...baselineProbe.expect, ...overrides } },
    ];
    routingProbes(withExpectation({ matchedBy: ["binding.peer"] }), [baselineProbe], true);
    routingProbes([], [baselineProbe], false);
    routingProbes(withExpectation({ matchedBy: [] }), [baselineProbe], false);
    routingProbes(withExpectation({ agentId: "Family" }), [baselineProbe], true);
    routingProbes(withExpectation({ agentId: "main" }), [baselineProbe], false);
    const scopedBaselineProbe = {
      ...baselineProbe,
      route: {
        ...baselineProbe.route,
        parentPeer: { kind: "group", id: "family-thread" },
        guildId: "home",
        teamId: "family",
      },
    };
    routingProbes(
      [
        {
          ...scopedBaselineProbe,
          route: {
            channel: " IMESSAGE ",
            accountId: " DEFAULT ",
            peer: { kind: "direct", id: " private " },
            parentPeer: { kind: "group", id: " family-thread " },
            guildId: " home ",
            teamId: " family ",
          },
        },
      ],
      [scopedBaselineProbe],
      true,
    );
    routingProbes(
      [{ ...baselineProbe, route: { ...baselineProbe.route, accountId: "*" } }],
      [baselineProbe],
      true,
    );
    const differentGuild = { ...scopedBaselineProbe.route, guildId: "other" };
    routingProbes(
      [{ ...scopedBaselineProbe, route: differentGuild }],
      [scopedBaselineProbe],
      false,
    );
  });
});
