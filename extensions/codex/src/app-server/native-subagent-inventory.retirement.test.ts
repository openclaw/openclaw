import { describe, expect, it, vi } from "vitest";
import { fixture } from "./native-subagent-inventory.test-support.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import {
  createClient,
  createMonitorFixture,
  nativeHistoryOwner,
  notifyChildStarted,
  threadRead,
} from "./native-subagent-monitor.test-support.js";
import { setupRunAttemptTestHooks } from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

describe("native parent retirement after rotation", () => {
  it.each([false, true])(
    "releases the earlier parent's live child pin (replacement detached: %s)",
    async (detached) => {
      const f = await fixture();
      const client = createClient();
      const releasePin = vi.fn();
      const first = await f.register(client, undefined, undefined, undefined, {
        retainParentThread: () => releasePin,
      });
      await first.ready;
      first.bindTurn("parent-turn");
      await f.spawn(client);
      await first.unregister();
      await f.store.mutate(f.identity, {
        kind: "replace-thread",
        expectedThreadId: "parent-thread",
        binding: { ...f.binding, threadId: "replacement-parent" },
      });
      client.setThreadRead(
        "child-thread",
        threadRead({ turnId: "child-turn", status: "inProgress" }),
      );
      const replacement = await f.register(client, f.historyOwner("replacement-parent"));
      try {
        await replacement.ready;
        if (detached) {
          await replacement.unregister();
        }
        expect(releasePin).not.toHaveBeenCalled();
        await codexNativeSubagentMonitorRuntime.retireParent(client.client, "replacement-parent");
        expect(releasePin).toHaveBeenCalledOnce();
        expect(f.deliver).not.toHaveBeenCalled();
      } finally {
        await codexNativeSubagentMonitorRuntime.retireParent(client.client, "parent-thread");
        await codexNativeSubagentMonitorRuntime.retireParent(client.client, "replacement-parent");
        await replacement.unregister();
      }
    },
  );

  it.each([
    ["requester", { requesterSessionKey: "agent:main:other" }, {}],
    ["session", {}, { sessionId: "other-physical-session" }],
    ["lifecycle", {}, { lifecycleRevision: "other-revision" }],
    ["connection", {}, { connectionFingerprint: "0".repeat(64) }],
    ["agent", { agentId: "other" }, {}],
  ] as const)(
    "preserves retained child ownership for a different %s",
    async (_difference, parentOverride, historyOverride) => {
      const releasePin = vi.fn();
      const { client, monitor } = createMonitorFixture({
        recoveryPollDelaysMs: [],
        retainParentThread: () => releasePin,
      });
      const original = {
        parentThreadId: "parent-thread",
        requesterSessionKey: "agent:main:original",
        agentId: "main",
        historyOwner: nativeHistoryOwner(),
      };
      const first = await monitor.registerParent(original);
      first.bindTurn("parent-turn");
      try {
        await notifyChildStarted(client);
        await first.unregister();
        const other = {
          ...original,
          parentThreadId: "other-parent",
          ...parentOverride,
          historyOwner: {
            ...original.historyOwner,
            parentThreadId: "other-parent",
            ...historyOverride,
          },
        };
        const replacement = await monitor.registerParent(other);
        await monitor.retireParent("other-parent");
        expect(releasePin).not.toHaveBeenCalled();
        await monitor.retireParent("parent-thread");
        expect(releasePin).toHaveBeenCalledOnce();
        await replacement.unregister();
      } finally {
        await monitor.dispose();
      }
    },
  );
});
