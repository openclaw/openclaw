import { describe, expect, it } from "vitest";
import { resolveCliRuntimeToolPolicy } from "./prepare-tool-policy.js";
import type { RunCliAgentParams } from "./types.js";

const params: RunCliAgentParams = {
  sessionId: "coding",
  sessionKey: "agent:coder:dashboard:coding",
  sessionFile: "fixture.jsonl",
  workspaceDir: "/workspace",
  prompt: "implement",
  provider: "fixture-cli",
  model: "fixture",
  runId: "fixture-run",
  timeoutMs: 1000,
  config: {
    agents: {
      entries: {
        intake: { subagents: { allowAgents: ["coder"], delegateToolsTo: ["coder"] } },
        coder: {},
      },
    },
  },
  sessionEntry: {
    sessionId: "coding",
    updatedAt: 1,
    spawnedBy: "agent:intake:main",
    spawnDepth: 1,
    inheritedToolPolicyVersion: 1,
    inheritedToolDeny: ["exec"],
    delegatedToolPolicy: {
      requesterSessionKey: "agent:intake:main",
      targetAgentId: "coder",
      deny: [],
      requesterDeny: ["exec"],
    },
  },
};
const input = {
  params,
  policyAgentId: "coder",
  policySessionKey: params.sessionKey,
  backendId: "fixture-cli",
  bundleMcp: true,
  canEnforceExactToolAvailability: true,
  isSideQuestion: false,
  skipsTurnPreparation: false,
};

describe("delegated CLI tool policy", () => {
  it("removes ambient tools and retains the policy-filtered host projection", () => {
    const result = resolveCliRuntimeToolPolicy(input);
    expect(result.params.cliToolAvailability).toEqual({ native: [], openClaw: [] });
    expect(result.runtimeToolsAllowPolicy).toEqual(["*"]);
  });
  it("refuses a backend that cannot enforce live delegated authority", () => {
    expect(() =>
      resolveCliRuntimeToolPolicy({ ...input, canEnforceExactToolAvailability: false }),
    ).toThrow("cannot enforce delegated execution tool policy");
  });
});
