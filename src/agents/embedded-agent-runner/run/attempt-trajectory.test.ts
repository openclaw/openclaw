import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  closeAdmittedRunDelegatedAuthority,
  prepareSystemAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "../../admitted-run-context.js";

const sessionTarget = {
  agentId: "main",
  sessionId: "session-1",
  sessionKey: "agent:main:session-1",
  storePath: "/tmp/openclaw-agent.sqlite",
};

const admissions: ReturnType<typeof prepareSystemAgentRunAdmission>[] = [];
afterEach(() => admissions.splice(0).forEach((admission) => admission.close()));

const { metadata, createRecorder, sessionFile } = vi.hoisted(() => ({
  metadata: vi.fn((_input: unknown) => ({ trace: "metadata" })),
  createRecorder: vi.fn(),
  sessionFile: vi.fn(async (_input: unknown) => "/tmp/trajectory.jsonl"),
}));

// mock-isolation: Capture attempt metadata without collecting real session/runtime metadata.
vi.mock("../../../trajectory/metadata.js", () => ({ buildTrajectoryRunMetadata: metadata }));
// mock-isolation: Recorder persistence is outside the attempt metadata contract.
vi.mock("../../../trajectory/runtime.js", () => ({
  createTrajectoryRuntimeRecorder: createRecorder,
}));
// mock-isolation: Supply a synthetic transcript path without opening the session store.
vi.mock("./attempt-transcript-helpers.js", () => ({
  resolveAttemptTrajectorySessionFile: sessionFile,
}));

import { prepareEmbeddedAttemptTrajectory } from "./attempt-trajectory.js";

async function createInput(retained = false, disableTrajectory = false, abortSignal?: AbortSignal) {
  const admission = prepareSystemAgentRunAdmission({}, "run-1", "main", "trajectory-test");
  admissions.push(admission);
  const admittedRunContext = await admission.admit("embedded");
  return {
    activeSession: { sessionId: "session-1" },
    transcriptOwner: retained
      ? {
          sessionTarget,
          assertCommitAllowed: resolveAdmittedRunActiveAssertion(admittedRunContext),
        }
      : undefined,
    attempt: {
      config: {},
      admittedRunContext,
      abortSignal,
      disableTrajectory,
      fastMode: true,
      model: { api: "anthropic-messages" },
      modelId: "model-1",
      provider: "provider-1",
      runId: "run-1",
      sessionFile: "/tmp/session.jsonl",
      sessionKey: "agent:main:session-1",
      sessionTarget,
      workspaceDir: "/tmp/workspace",
    },
    clientToolCount: 2,
    effectiveToolCount: 7,
    effectiveWorkspace: "/tmp/workspace",
    localModelLeanEnabled: false,
    sessionAgentId: "main",
  };
}

beforeEach(() => vi.clearAllMocks());

it.each([false, true])("creates trajectory metadata with retained target: %s", async (retained) => {
  const recorder = { recordEvent: vi.fn() };
  createRecorder.mockReturnValue(recorder);

  const input = await createInput(retained);
  expect(await prepareEmbeddedAttemptTrajectory(input as never)).toBe(recorder);
  if (retained) {
    expect(sessionFile).not.toHaveBeenCalled();
  } else {
    expect(sessionFile.mock.calls[0]?.[0]).toMatchObject({
      agentId: "main",
      sessionFile: "/tmp/session.jsonl",
      sessionId: "session-1",
    });
  }
  expect(createRecorder.mock.calls[0]?.[0]).toMatchObject({
    runId: "run-1",
    sessionFile: retained ? input.attempt.sessionKey : "/tmp/trajectory.jsonl",
    sessionId: "session-1",
    sessionTarget,
  });
  expect(recorder.recordEvent.mock.calls.slice(0, 2)).toEqual([
    ["session.started", expect.objectContaining({ toolCount: 7, clientToolCount: 2 })],
    ["trace.metadata", { trace: "metadata" }],
  ]);
  expect(metadata.mock.calls[0]?.[0]).toMatchObject({ fastMode: true, provider: "provider-1" });
});

it.each(["revoke", "abort"])(
  "does not record prepared metadata after %s during sink preparation",
  async (change) => {
    const abort = new AbortController();
    const input = await createInput(true, false, abort.signal);
    const recorder = { recordEvent: vi.fn() };
    createRecorder.mockImplementation(async () => {
      if (change === "revoke") {
        closeAdmittedRunDelegatedAuthority(input.attempt.admittedRunContext);
      } else {
        abort.abort();
      }
      return recorder;
    });
    await expect(prepareEmbeddedAttemptTrajectory(input as never)).rejects.toThrow(
      "admitted run authority is no longer active",
    );
    expect(recorder.recordEvent).not.toHaveBeenCalled();
  },
);

it("keeps trajectory path resolution but skips recorder creation when disabled", async () => {
  const input = await createInput(false, true);
  expect(await prepareEmbeddedAttemptTrajectory(input as never)).toBeNull();
  expect([
    sessionFile.mock.calls.length,
    createRecorder.mock.calls.length,
    metadata.mock.calls.length,
  ]).toEqual([1, 0, 0]);
});
