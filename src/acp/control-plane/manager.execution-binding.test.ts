import { describe, expect, it, vi } from "vitest";
import { withAcpManagerTaskStateDir } from "../../../test/helpers/acp-manager-task-state.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { prepareSystemAgentRunAdmission } from "../../agents/admitted-run-context.js";
import * as backgroundTask from "./manager.background-task.js";
import {
  AcpSessionManager,
  baseCfg,
  createRuntime,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  mockParentedAcpSessionEntries,
  readySessionMeta,
} from "./manager.test-helpers.js";

describe("ACP execution binding authority", () => {
  installAcpSessionManagerTestLifecycle();

  function setupPromptStartedRuntime() {
    const runtimeState = createRuntime();
    const sessionKey = "agent:codex:acp:session-1";
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey,
      storeSessionKey: sessionKey,
      acp: readySessionMeta(),
    });
    return { runtimeState, sessionKey };
  }

  it("does not notify prompt submission after admitted authority closes during binding", async () => {
    await withAcpManagerTaskStateDir(async () => {
      const { runtimeState, sessionKey } = setupPromptStartedRuntime();
      mockParentedAcpSessionEntries({
        childSessionKey: sessionKey,
        parentSessionKey: "agent:main:main",
      });
      const runId = "closed-during-binding";
      const admission = prepareSystemAgentRunAdmission(baseCfg, runId, "codex", "test");
      const admittedRunContext = await admission.admit("acp");
      const bindingEntered = createDeferred();
      const bindingRelease = createDeferred();
      const result = createDeferred<{ status: "completed" }>();
      const binding = vi
        .spyOn(backgroundTask, "bindBackgroundTaskExecution")
        .mockImplementationOnce(async () => {
          bindingEntered.resolve();
          await bindingRelease.promise;
        });
      runtimeState.runtime.startTurn = vi.fn((input) => ({
        requestId: input.requestId,
        promptStarted: Promise.resolve(),
        events: (async function* () {})(),
        result: result.promise,
        cancel: vi.fn(async () => {}),
        closeStream: vi.fn(async () => {}),
      }));
      const onLifecycle = vi.fn();
      const turn = new AcpSessionManager().runTurn({
        provenance: "system",
        cfg: baseCfg,
        sessionKey,
        text: "submit once",
        mode: "prompt",
        requestId: runId,
        admittedRunContext,
        onLifecycle,
      });
      const outcome = turn.then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        await Promise.race([
          bindingEntered.promise,
          turn.then(() => {
            throw new Error("ACP turn settled before entering binding");
          }),
        ]);
        admission.close();
        bindingRelease.resolve();
        result.resolve({ status: "completed" });
        const error = await outcome;
        expect(onLifecycle).not.toHaveBeenCalled();
        expect(error).toMatchObject({
          message: expect.stringContaining("authority is no longer active"),
        });
      } finally {
        admission.close();
        bindingRelease.resolve();
        result.resolve({ status: "completed" });
        await outcome;
        binding.mockRestore();
      }
    });
  });
});
