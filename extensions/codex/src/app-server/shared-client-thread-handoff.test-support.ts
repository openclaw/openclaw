import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import { CodexAppServerClient } from "./client.js";
import {
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
  retireSharedCodexAppServerClientIfCurrent,
} from "./shared-client.js";
import { createClientHarness } from "./test-support.js";
import { createCodexThreadLifecycleTimingTracker } from "./thread-lifecycle-timing.js";
import { releaseCodexBoundLiveThread } from "./thread-lifecycle-warm.js";
import { withCodexAppServerThreadMutation } from "./thread-ownership-queue.js";
import {
  releaseCodexAppServerBindingSubscription,
  retainCodexAppServerBindingSubscription,
} from "./thread-ownership.js";

/** Share the parent suite's real client initialization and authoritative auth mocks. */
export function registerSharedClientThreadHandoffTests(
  initialize: (harness: ReturnType<typeof createClientHarness>, userAgent: string) => Promise<void>,
) {
  it.each(
    (["websocket", "unix", "stdio"] as const).flatMap((transport) =>
      (["resume", "binding cleanup"] as const).map((operation) => ({ transport, operation })),
    ),
  )(
    "hands off a released $transport thread during $operation without borrowing sibling process ownership",
    async ({ transport, operation }) => {
      const old = createClientHarness();
      const replacement = createClientHarness();
      vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(old.client);
      const acquire = getLeasedSharedCodexAppServerClient({
        timeoutMs: 1_000,
        startOptions: {
          transport,
          command: "codex",
          args: ["app-server"],
          headers: {},
          ...(transport === "websocket" ? { url: "ws://127.0.0.1:8123" } : {}),
          ...(transport === "unix" ? { url: "unix:///tmp/synthetic-codex.sock" } : {}),
        },
      });
      await initialize(old, "openclaw/0.163.0 (Linux; test)");
      const client = await acquire;
      const unsubscribe = createDeferred<void>();
      const entered = createDeferred<void>();
      const threadId = `released-${transport}-thread`;
      await retainCodexAppServerBindingSubscription(client, threadId, {
        release: async () => {
          entered.resolve();
          await unsubscribe.promise;
        },
      });
      // This lease represents a different conversation. It may outlive many
      // startup deadlines; neither a handoff nor its cancellation may kill it.
      retireSharedCodexAppServerClientIfCurrent(client);
      let settled = false;
      let successorEntered = false;
      const handoff = withCodexAppServerThreadMutation(threadId, async () =>
        operation === "resume"
          ? releaseCodexBoundLiveThread({
              client: replacement.client,
              clientId: replacement.client.getInstanceId(),
              ownerClientId: client.getInstanceId(),
              threadId,
              lifecycleTiming: createCodexThreadLifecycleTimingTracker(),
            })
          : releaseCodexAppServerBindingSubscription({
              threadId,
              clientId: client.getInstanceId(),
            }).then(() => true),
      ).then((released) => {
        settled = true;
        return released;
      });
      const successor = withCodexAppServerThreadMutation(threadId, async () => {
        successorEntered = true;
      });
      try {
        await entered.promise;
        expect(settled).toBe(false);
        expect(successorEntered).toBe(false);
        unsubscribe.resolve();
        await setImmediate();
        // Only confirmed external-socket releases can bypass graceful retirement.
        // The stdio case guards the compaction writer's physical-exit fence.
        expect(settled).toBe(transport !== "stdio");
        expect(successorEntered).toBe(transport !== "stdio");
        expect(client.getCloseError()).toBeUndefined();
      } finally {
        unsubscribe.resolve();
        releaseLeasedSharedCodexAppServerClient(client);
        await expect(handoff).resolves.toBe(true);
        await successor;
        replacement.client.close();
      }
      expect(client.getCloseError()).toBeDefined();
    },
  );
}
