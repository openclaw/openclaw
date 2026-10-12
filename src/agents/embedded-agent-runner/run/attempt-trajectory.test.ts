import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeAdmittedRunDelegatedAuthority,
  prepareSystemAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "../../admitted-run-context.js";

const admissions: ReturnType<typeof prepareSystemAgentRunAdmission>[] = [];
afterEach(() => {
  for (const admission of admissions.splice(0)) {
    admission.close();
  }
});

const hoisted = vi.hoisted(() => ({
  buildTrajectoryRunMetadata: vi.fn(() => ({ trace: "metadata" })),
  createTrajectoryRuntimeRecorder: vi.fn(),
  resolveAttemptTrajectorySessionFile: vi.fn(async () => "/tmp/trajectory.jsonl"),
}));

vi.mock("../../../trajectory/metadata.js", () => ({
  buildTrajectoryRunMetadata: hoisted.buildTrajectoryRunMetadata,
}));
// mock-isolation: Recorder persistence is outside the attempt metadata contract.
vi.mock("../../../trajectory/runtime.js", () => ({
  createTrajectoryRuntimeRecorder: hoisted.createTrajectoryRuntimeRecorder,
}));
vi.mock("./attempt-transcript-helpers.js", () => ({
  resolveAttemptTrajectorySessionFile: hoisted.resolveAttemptTrajectorySessionFile,
}));

import { prepareEmbeddedAttemptTrajectory } from "./attempt-trajectory.js";

async function createInput(disableTrajectory = false, abortSignal?: AbortSignal) {
  const admission = prepareSystemAgentRunAdmission({}, "run-1", "main", "trajectory-test");
  admissions.push(admission);
  const admittedRunContext = await admission.admit("embedded");
  return {
    activeSession: { sessionId: "session-1" },
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
      sessionTarget: {
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        storePath: "/tmp/openclaw-agent.sqlite",
      },
      thinkLevel: "medium",
      trigger: "user",
      workspaceDir: "/tmp/workspace",
    },
    clientToolCount: 2,
    effectiveToolCount: 7,
    effectiveWorkspace: "/tmp/workspace",
    localModelLeanEnabled: false,
    sessionAgentId: "main",
  };
}

describe("prepareEmbeddedAttemptTrajectory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([false, true])(
    "creates trajectory metadata with retained target: %s",
    async (retained) => {
      const recorder = { recordEvent: vi.fn() };
      hoisted.createTrajectoryRuntimeRecorder.mockReturnValue(recorder);

      const input = await createInput();
      const result = await prepareEmbeddedAttemptTrajectory({
        ...input,
        ...(retained
          ? {
              transcriptOwner: {
                sessionTarget: input.attempt.sessionTarget,
                assertCommitAllowed: resolveAdmittedRunActiveAssertion(
                  input.attempt.admittedRunContext,
                ),
              },
            }
          : {}),
      } as never);

      expect(result).toBe(recorder);
      if (retained) {
        expect(hoisted.resolveAttemptTrajectorySessionFile).not.toHaveBeenCalled();
      } else {
        expect(hoisted.resolveAttemptTrajectorySessionFile).toHaveBeenCalledWith(
          expect.objectContaining({
            agentId: "main",
            sessionFile: "/tmp/session.jsonl",
            sessionId: "session-1",
          }),
        );
      }
      expect(hoisted.createTrajectoryRuntimeRecorder).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "run-1",
          sessionFile: retained ? input.attempt.sessionKey : "/tmp/trajectory.jsonl",
          sessionId: "session-1",
          sessionTarget: expect.objectContaining({
            agentId: "main",
            sessionId: "session-1",
            sessionKey: "agent:main:session-1",
            storePath: "/tmp/openclaw-agent.sqlite",
          }),
        }),
      );
      expect(recorder.recordEvent).toHaveBeenNthCalledWith(
        1,
        "session.started",
        expect.objectContaining({ toolCount: 7, clientToolCount: 2 }),
      );
      expect(recorder.recordEvent).toHaveBeenNthCalledWith(2, "trace.metadata", {
        trace: "metadata",
      });
      expect(hoisted.buildTrajectoryRunMetadata).toHaveBeenCalledWith(
        expect.objectContaining({ fastMode: true, provider: "provider-1" }),
      );
    },
  );

  it.each(["revoke", "abort"])(
    "does not record prepared metadata after %s during sink preparation",
    async (change) => {
      const abort = new AbortController();
      const input = await createInput(false, abort.signal);
      const recorder = { recordEvent: vi.fn() };
      hoisted.createTrajectoryRuntimeRecorder.mockImplementation(async () => {
        if (change === "revoke") {
          closeAdmittedRunDelegatedAuthority(input.attempt.admittedRunContext);
        } else {
          abort.abort();
        }
        return recorder;
      });
      await expect(
        prepareEmbeddedAttemptTrajectory({
          ...input,
          transcriptOwner: {
            sessionTarget: input.attempt.sessionTarget,
            assertCommitAllowed: resolveAdmittedRunActiveAssertion(
              input.attempt.admittedRunContext,
            ),
          },
        } as never),
      ).rejects.toThrow("admitted run authority is no longer active");
      expect(recorder.recordEvent).not.toHaveBeenCalled();
    },
  );

  it("keeps trajectory path resolution but skips recorder creation when disabled", async () => {
    await expect(
      prepareEmbeddedAttemptTrajectory((await createInput(true)) as never),
    ).resolves.toBeNull();

    expect(hoisted.resolveAttemptTrajectorySessionFile).toHaveBeenCalledOnce();
    expect(hoisted.createTrajectoryRuntimeRecorder).not.toHaveBeenCalled();
    expect(hoisted.buildTrajectoryRunMetadata).not.toHaveBeenCalled();
  });
});
