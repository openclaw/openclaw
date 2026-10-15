import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createTestReplyOperation } from "../auto-reply/reply/reply-run-registry.test-helpers.js";
import { testing } from "../auto-reply/reply/reply-run-registry.test-support.js";
import { bindReplyOperationTyping } from "../auto-reply/reply/reply-run-typing.js";
import { createTypingController } from "../auto-reply/reply/typing.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { createProcessSupervisor } from "../process/supervisor/supervisor.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  deleteSession,
  getFinishedSession,
  listActiveBackgroundProcessSessions,
  markBackgrounded,
  subscribeProcessSessionChanges,
} from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { runExecProcess } from "./bash-tools.exec-runtime.js";
import { createProcessTool } from "./bash-tools.process.js";

vi.mock("../process/supervisor/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/supervisor/index.js")>()),
  getProcessSupervisor: () => supervisor,
}));

let supervisor: ReturnType<typeof createProcessSupervisor>;
let scopeKey = "";
let processHandle: Awaited<ReturnType<typeof runExecProcess>> | undefined;
let ownerRunId: string | undefined;
let typing: ReturnType<typeof createTypingController> | undefined;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeEach(() => {
  supervisor = createProcessSupervisor();
  scopeKey = "agent:main:discord:channel:exec-typing-" + randomUUID();
  processHandle = undefined;
  ownerRunId = undefined;
  typing = undefined;
});

afterEach(async () => {
  typing?.cleanup();
  if (processHandle) {
    processHandle.kill();
    await processHandle.promise;
  }
  if (ownerRunId) {
    clearAgentRunContext(ownerRunId);
  }
  await supervisor.shutdown();
  resetProcessRegistryForTests();
  testing.resetReplyRunRegistry();
  vi.useRealTimers();
});

it.skipIf(process.platform === "win32")(
  "keeps typing for a supervisor-spawned background exec owner and stops at exact kill",
  async () => {
    const cwd = tempDirs.make("typing-exec-owner-");
    const runId = "exec-owner-run-" + randomUUID();
    ownerRunId = runId;
    const sessionKey = scopeKey;
    const conversationSessionId = "exec-owner-session-" + randomUUID();
    await withEnvAsync(
      {
        OPENCLAW_SERVICE_MARKER: "typing-exec-owner-test",
        OPENCLAW_STATE_DIR: cwd + "/state",
        OPENCLAW_HOME: cwd,
        OPENCLAW_EXEC_SHELL_SNAPSHOT: "0",
        SHELL: "/bin/sh",
      },
      async () => {
        registerAgentRunContext(runId, {
          sessionKey,
          sessionId: conversationSessionId,
          agentId: "main",
        });
        const command =
          "exec " +
          JSON.stringify(process.execPath) +
          " -e " +
          JSON.stringify("setInterval(() => {}, 1000)");
        const handle = await runExecProcess({
          command,
          workdir: cwd,
          env: {
            PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
            HOME: process.env.HOME ?? cwd,
          },
          usePty: false,
          warnings: [],
          maxOutput: 2048,
          pendingMaxOutput: 2048,
          notifyOnExit: false,
          notifyOnExitEmptySuccess: false,
          timeoutSec: null,
          processContinuationAvailable: true,
          scopeKey,
          sessionKey,
          agentRunId: runId,
          agentId: "main",
        });
        processHandle = handle;
        const session = handle.session;
        markBackgrounded(session);
        expect(session).toMatchObject({
          agentRunId: runId,
          sessionKey,
          scopeKey,
          backgrounded: true,
          exited: false,
        });
        expect(session.processActivity?.resultSettled).toBe(false);
        expect(typeof session.pid).toBe("number");
        const pid = session.pid;
        if (!pid) {
          throw new Error("real exec process did not publish its owner PID");
        }
        expect(isPidAlive(pid)).toBe(true);
        expect(listActiveBackgroundProcessSessions()).toContain(session);

        vi.useFakeTimers();
        const typingStarts = vi.fn();
        const typingController = createTypingController({
          onReplyStart: typingStarts,
          typingIntervalSeconds: 1,
        });
        typing = typingController;
        typingController.setBackgroundWorkPause?.(
          vi.fn(),
          JSON.stringify(["discord", "test-account", sessionKey]),
        );
        typingController.bindRunIdentity?.(runId, sessionKey, conversationSessionId);
        await typingController.startTypingLoop();
        await vi.dynamicImportSettled();
        const replyOperation = createTestReplyOperation({
          sessionKey,
          sessionId: conversationSessionId,
        });
        replyOperation.setPhase("running");
        bindReplyOperationTyping(replyOperation, typingController);
        replyOperation.complete();
        await Promise.resolve();
        await Promise.resolve();
        expect(typingController.shouldRetainChannelCallbacks?.()).toBe(true);
        await vi.advanceTimersByTimeAsync(6_000);
        expect(typingStarts.mock.calls.length).toBeGreaterThanOrEqual(5);
        expect(isPidAlive(pid)).toBe(true);
        expect(listActiveBackgroundProcessSessions()).toContain(session);

        let resolveTerminal: (() => void) | undefined;
        const terminal = new Promise<void>((resolve) => {
          resolveTerminal = resolve;
        });
        const unsubscribe = subscribeProcessSessionChanges((changed) => {
          if (changed.id === session.id && changed.exited && !changed.finalizing) {
            resolveTerminal?.();
          }
        });
        try {
          const killed = await createProcessTool({ scopeKey }).execute("typing-exec-owner-kill", {
            action: "kill",
            sessionId: session.id,
          });
          expect(killed.content[0]).toMatchObject({ text: expect.stringContaining(session.id) });
          await terminal;
          await handle.promise;
          expect(isPidAlive(pid)).toBe(false);
          expect(listActiveBackgroundProcessSessions()).not.toContain(session);
          const afterKill = typingStarts.mock.calls.length;
          await vi.advanceTimersByTimeAsync(4_000);
          expect(typingStarts).toHaveBeenCalledTimes(afterKill);
          expect(typingController.shouldRetainChannelCallbacks?.()).toBe(false);

          // The observers and controller are already retired. The sole remaining
          // timer belongs to this exact finished process's retained registry row.
          expect(getFinishedSession(session.id)).toBe(session);
          expect(session.expiresAt).toBeGreaterThan(Date.now());
          expect(vi.getTimerCount()).toBe(1);
          deleteSession(session.id);
          expect(getFinishedSession(session.id)).toBeUndefined();
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          unsubscribe();
        }
      },
    );
  },
  15_000,
);
