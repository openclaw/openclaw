import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AgentInternalEvent } from "../internal-events.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";

// Guardrail tests for RunEmbeddedPiAgentParams optional fields that must flow
// through to runEmbeddedAttempt. The call site in run.ts hand-enumerates ~85
// fields into the runEmbeddedAttempt({...}) object literal, which makes it
// easy to add a new optional field to the params type without wiring it at the
// call site. Because the type declares these fields as `?:` optional, a missed
// field is silently undefined in the attempt and TypeScript does not flag it.
// Previous incidents: bootstrapContextMode/bootstrapContextRunKind (#62264)
// and toolsAllow / disableMessageTool / requireExplicitMessageTarget /
// internalEvents (#62569).

let runEmbeddedPiAgent: typeof import("./run.js").runEmbeddedPiAgent;

describe("runEmbeddedPiAgent forwards optional params to runEmbeddedAttempt", () => {
  beforeAll(async () => {
    ({ runEmbeddedPiAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
  });

  it("forwards toolsAllow so the per-job tool allowlist can be honored", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      runId: "forward-toolsAllow",
      toolsAllow: ["exec", "read"],
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ toolsAllow: ["exec", "read"] }),
    );
  });

  it("forwards bootstrapContextMode so lightContext cron jobs strip workspace bootstrap files", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      runId: "forward-bootstrapContextMode",
      bootstrapContextMode: "lightweight",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ bootstrapContextMode: "lightweight" }),
    );
  });

  it("forwards bootstrapContextRunKind so the bootstrap filter knows the caller context", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      runId: "forward-bootstrapContextRunKind",
      bootstrapContextRunKind: "cron",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ bootstrapContextRunKind: "cron" }),
    );
  });

  it("forwards disableMessageTool so cron-owned delivery suppresses the messaging tool", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      runId: "forward-disableMessageTool",
      disableMessageTool: true,
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ disableMessageTool: true }),
    );
  });

  it("forwards requireExplicitMessageTarget so non-subagent callers can opt in explicitly", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      runId: "forward-requireExplicitMessageTarget",
      requireExplicitMessageTarget: true,
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ requireExplicitMessageTarget: true }),
    );
  });

  it("forwards internalEvents so the agent command attempt path can deliver internal events", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    const internalEvents: AgentInternalEvent[] = [];
    await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      runId: "forward-internalEvents",
      internalEvents,
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ internalEvents }),
    );
  });
});
