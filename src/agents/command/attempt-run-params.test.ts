import { expect, it } from "vitest";
import { createTestPreparedRunAdmission } from "../admitted-run-context.test-support.js";
import type { AgentAttemptParams } from "./attempt-execution.types.js";
import { buildCommonCommandRunParams } from "./attempt-run-params.js";

it("selects the target session profile for internal command deliveries only", () => {
  const params: AgentAttemptParams = {
    preparedRunAdmission: createTestPreparedRunAdmission("profile-continuation"),
    providerOverride: "openai",
    originalProvider: "openai",
    modelOverride: "gpt-5.4",
    modelRoutingProvenance: {
      requestedProvider: "openai",
      requestedModel: "gpt-5.4",
      stage: "initial",
    },
    cfg: {},
    sessionEntry: {
      sessionId: "conversation",
      updatedAt: 1,
      owner: { actor: { type: "human", id: "selected-human" } },
    },
    sessionId: "conversation",
    sessionKey: "agent:main:conversation",
    sessionAgentId: "main",
    sessionFile: "/synthetic/session.jsonl",
    workspaceDir: "/synthetic/workspace",
    agentDir: "/synthetic/agent",
    body: "Continue",
    resolvedThinkLevel: "off",
    timeoutMs: 1000,
    runId: "profile-continuation",
    lifecycleGeneration: "fixture",
    opts: { message: "Continue" },
    runContext: {},
    spawnedBy: undefined,
    messageChannel: undefined,
    skillsSnapshot: undefined,
    resolvedVerboseLevel: undefined,
    onAgentEvent: () => {},
    authProfileProvider: "openai",
    pluginGeneration: undefined,
    isFallbackRetry: false,
  };
  const run = () =>
    buildCommonCommandRunParams(params, {
      disableTools: false,
      bootstrapPromptWarningSignaturesSeen: [],
    });
  expect(run().bootstrapUserProfileId).toBeUndefined();
  for (const sourceTool of ["subagent_settle", "subagent_announce", "sessions_send"]) {
    params.opts.inputProvenance = { kind: "inter_session", sourceTool };
    expect(run().bootstrapUserProfileId).toBe("selected-human");
  }
  params.opts.inputProvenance = { kind: "internal_system", sourceTool: "goal_continue" };
  expect(run().bootstrapUserProfileId).toBe("selected-human");
  params.sessionEntry = {
    sessionId: "delegated-session",
    updatedAt: 1,
    createdActor: {
      type: "agent",
      id: "main",
      delegatedBy: { type: "human", source: "profile", id: "delegating-human" },
    },
  };
  expect(run().bootstrapUserProfileId).toBe("delegating-human");
  params.sessionEntry = { sessionId: "separate-internal-session", updatedAt: 1 };
  expect(run().bootstrapUserProfileId).toBeUndefined();
});
