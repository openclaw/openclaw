import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../../config/io.js";
import { createTestInstance } from "../../../plugins/plugin-instance.test-support.js";
import { PluginInvocationScope } from "../../../plugins/plugin-invocation-scope.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import {
  createLifecycleControllerFixture,
  createRunEntry,
} from "./subagent-registry-lifecycle-controller.test-support.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";

beforeEach(() => setRuntimeConfigSnapshot({}));
afterEach(() => clearRuntimeConfigSnapshot());

it("detaches completion cleanup and requester wake from a closed child plugin scope", async () => {
  const entry = createRunEntry({
    endedAt: 4_000,
    outcome: { status: "ok" },
    expectsCompletionMessage: true,
  });
  const instance = createTestInstance("completion-owner");
  const caller = new PluginInvocationScope(createEmptyPluginRegistry(), [instance]);
  const entered = createDeferred();
  const release = createDeferred();
  const events: string[] = [];
  const pluginWork = instance.wrap((event: string) => {
    events.push(event);
  });
  const controller = createLifecycleControllerFixture(
    {
      entry,
      beforeWrite: async () => {
        entered.resolve();
        await release.promise;
      },
      notifyContextEngineSubagentEnded: async () => {
        pluginWork("context-ended");
      },
      maybeWakeRequesterAfterAllChildrenSettled: async ({ completeBatch, settledEntry }) => {
        pluginWork("requester-wake");
        await completeBatch([settledEntry]);
        return true;
      },
    },
    {
      ownersByEntry: new Map(),
      callGateway: vi.fn(),
      cleanupBrowserSessionsForLifecycleEnd: vi.fn(),
    },
  );
  const settle = observeRootWork();
  const completion = caller.run(() =>
    controller.completeCleanupBookkeeping({
      runId: entry.runId,
      entry,
      cleanup: "keep",
      completedAt: 5_000,
      preserveTranscript: true,
    }),
  );
  try {
    await entered.promise;
    caller.release();
    release.resolve();
    await completion;
    await settle();
    expect(events.toSorted()).toEqual(["context-ended", "requester-wake"]);
  } finally {
    caller.release();
    release.resolve();
    await completion.catch(() => {});
    controller.clearRuntimeState();
  }
});
