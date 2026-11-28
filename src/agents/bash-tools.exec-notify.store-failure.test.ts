import "../test-utils/prepare-compiled-subprocesses.js";
import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { addSession } from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { maybeNotifyOnExit, prepareExecExitNotification } from "./bash-tools.exec-notify.js";

const enqueue = vi.hoisted(() => vi.fn());
// mock-isolation: Capture the completion wake without starting a session turn.
vi.mock("../auto-reply/reply/session-event-batch.js", () => ({
  enqueueBatchedSessionEventForHost: enqueue,
}));
vi.mock("../sessions/owed.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sessions/owed.js")>()),
  owe: vi.fn(async () => {
    throw new Error("database is locked");
  }),
}));

it("delivers a finished command's result when its owed row cannot be stored", async () => {
  await withOpenClawTestState({ label: "exec-owe-failure" }, async (state) => {
    const sessionKey = "agent:main:exec-owe-failure";
    setRuntimeConfigSnapshot({ agents: { entries: { main: {} } } });
    openOpenClawStateDatabase({ env: state.env });
    writeSessionEntry(openOpenClawAgentDatabase({ agentId: "main", env: state.env }), sessionKey, {
      sessionId: "exec-owe-failure",
      updatedAt: Date.now(),
    });
    enqueue.mockReturnValue({
      id: "wake",
      cancel: () => true,
      accepted: Promise.resolve({ ok: true }),
      settled: Promise.resolve({ status: "completed", executionStarted: true, delivered: true }),
    });
    const process = createProcessSessionFixture({ id: "owe-failure", backgrounded: true });
    Object.assign(process, {
      agentId: "main",
      sessionKey,
      notifyOnExit: true,
      notifyOnExitEmptySuccess: true,
      exitCode: 0,
    });
    try {
      await prepareExecExitNotification(process, false, false);
      addSession(process);

      await maybeNotifyOnExit(process, "completed", false);

      // The store failure is not the user's loss: the result still wakes its chat, once.
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(enqueue.mock.calls[0]?.[0]).toContain("Exec completed");
      expect(enqueue.mock.calls[0]?.[1]).toMatchObject({
        agentId: "main",
        sessionKey,
        source: "exec",
      });
    } finally {
      resetProcessRegistryForTests();
    }
  });
});
