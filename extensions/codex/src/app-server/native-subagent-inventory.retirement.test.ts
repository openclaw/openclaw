import { describe, expect, it, vi } from "vitest";
import { fixture } from "./native-subagent-inventory.test-support.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import {
  createClient,
  createRuntime,
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
        codexNativeSubagentMonitorRuntime.retireParent(client.client, "replacement-parent");
        expect(releasePin).toHaveBeenCalledOnce();
        expect(f.deliver).not.toHaveBeenCalled();
      } finally {
        codexNativeSubagentMonitorRuntime.retireParent(client.client, "parent-thread");
        codexNativeSubagentMonitorRuntime.retireParent(client.client, "replacement-parent");
        await replacement.unregister();
        client.close();
      }
    },
  );

  it.each(["requester", "session", "lifecycle", "connection", "agent"] as const)(
    "preserves retained child ownership for a different %s",
    async (difference) => {
      const client = createClient();
      const releasePin = vi.fn();
      const monitor = new codexNativeSubagentMonitorRuntime.Monitor(
        client.client,
        createRuntime(),
        {
          recoveryPollDelaysMs: [],
          retainParentThread: () => releasePin,
        },
      );
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
          historyOwner: { ...original.historyOwner, parentThreadId: "other-parent" },
        };
        if (difference === "requester") {
          other.requesterSessionKey = "agent:main:other";
        } else if (difference === "session") {
          other.historyOwner.sessionId = "other-physical-session";
        } else if (difference === "lifecycle") {
          other.historyOwner.lifecycleRevision = "other-revision";
        } else if (difference === "connection") {
          other.historyOwner.connectionFingerprint = "0".repeat(64);
        } else {
          other.agentId = "other";
        }
        const replacement = await monitor.registerParent(other);
        monitor.retireParent("other-parent");
        expect(releasePin).not.toHaveBeenCalled();
        monitor.retireParent("parent-thread");
        expect(releasePin).toHaveBeenCalledOnce();
        await replacement.unregister();
      } finally {
        monitor.dispose();
        client.close();
      }
    },
  );
});
