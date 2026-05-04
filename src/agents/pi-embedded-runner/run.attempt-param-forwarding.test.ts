import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentInternalEvent } from "../internal-events.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import type { RunEmbeddedPiAgentParams } from "./run/params.js";

const agentEvents: Array<{ stream: string; data: Record<string, unknown> }> = [];

type ForwardingCase = {
  runId: string;
  params: Partial<RunEmbeddedPiAgentParams>;
  expected: Record<string, unknown>;
};

let runEmbeddedPiAgent: typeof import("./run.js").runEmbeddedPiAgent;
const internalEvents: AgentInternalEvent[] = [];
const forwardingCase = {
  runId: "forward-attempt-params",
  params: {
    toolsAllow: ["exec", "read"],
    embeddedMcpPolicy: { externalMcpEnabled: false, allowedMcpServers: [] },
    bootstrapContextMode: "lightweight",
    bootstrapContextRunKind: "cron",
    disableMessageTool: true,
    forceMessageTool: true,
    requireExplicitMessageTarget: true,
    internalEvents,
  },
  expected: {
    toolsAllow: ["exec", "read"],
    embeddedMcpPolicy: { externalMcpEnabled: false, allowedMcpServers: [] },
    bootstrapContextMode: "lightweight",
    bootstrapContextRunKind: "cron",
    disableMessageTool: true,
    forceMessageTool: true,
    requireExplicitMessageTarget: true,
    internalEvents,
  },
} satisfies ForwardingCase;

describe("runEmbeddedPiAgent forwards optional params to runEmbeddedAttempt", () => {
  beforeAll(async () => {
    ({ runEmbeddedPiAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
    agentEvents.length = 0;
    vi.unstubAllEnvs();
  });

  it("forwards optional attempt params in one attempt call", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      ...forwardingCase.params,
      runId: forwardingCase.runId,
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    const call = mockedRunEmbeddedAttempt.mock.calls[0]?.[0];
    expect(call).toEqual(expect.objectContaining(forwardingCase.expected));
  });

  it("emits embedded runner entry and before-models-json markers truthfully", async () => {
    vi.stubEnv("OPENCLAW_AGENT_EXEC_DEBUG", "1");
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      runId: "embedded-runner-debug",
      commandName: "agent-exec",
      effectiveToolPolicy: "coordination_only",
      onAgentEvent: (evt) => agentEvents.push(evt),
    });

    const entry = agentEvents.find(
      (evt) => evt.data?.event === "embeddedRunner_runEmbeddedPiAgent_enter",
    );
    const beforeModels = agentEvents.find(
      (evt) => evt.data?.event === "embeddedRunner_before_ensureOpenClawModelsJson",
    );
    expect(entry?.data).toEqual(
      expect.objectContaining({
        raw_commandName: "agent-exec",
        raw_effectiveToolPolicy: "coordination_only",
        has_commandName: true,
        has_effectiveToolPolicy: true,
        will_forward_to_ensureOpenClawModelsJson: true,
        will_forward_to_resolveModelAsync: true,
      }),
    );
    expect(beforeModels?.data).toEqual(
      expect.objectContaining({
        raw_commandName: "agent-exec",
        raw_effectiveToolPolicy: "coordination_only",
        has_commandName: true,
        has_effectiveToolPolicy: true,
        calls_ensureOpenClawModelsJson: true,
      }),
    );
  });
});
