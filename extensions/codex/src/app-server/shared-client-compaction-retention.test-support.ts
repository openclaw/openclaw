import { once } from "node:events";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { expect, it, vi } from "vitest";
import {
  hasCodexAppServerLiveThread,
  protectCodexAppServerLiveThread,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import { CodexAppServerClient } from "./client.js";
import {
  maybeCompactCodexAppServerSession,
  writeCompactionTestBinding,
} from "./compact.test-support.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import type { CodexServerNotification } from "./protocol.js";
import { resetCodexTestBindingStore } from "./session-binding.test-helpers.js";
import {
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
  retainSharedCodexAppServerClientIfCurrent,
  retireSharedCodexAppServerClientIfCurrent,
} from "./shared-client.js";
import { createClientHarness } from "./test-support.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

/** Register under the shared-client suite; retain its auth mocks and cleanup owner. */
export function registerSharedClientCompactionRetentionTests() {
  it("retains ordinary native children when compaction created the cached monitor first", async () => {
    await withStateDirEnv("openclaw-codex-compaction-retention-", async ({ tempRoot }) => {
      resetCodexTestBindingStore();
      const unsubscribed: string[] = [];
      const harness = createClientHarness({
        onWrite(line, send) {
          const request = JSON.parse(line) as {
            id?: number;
            method: string;
            params?: { threadId: string };
          };
          if (request.id === undefined) {
            return;
          }
          if (request.method === "initialize") {
            send({
              id: request.id,
              result: { userAgent: `codex-cli/${CODEX_APP_SERVER_VERSION}` },
            });
          } else if (request.method === "thread/compact/start") {
            const threadId = request.params?.threadId;
            send({
              method: "turn/started",
              params: { threadId, turn: { id: "compact-turn", status: "inProgress" } },
            });
            send({
              method: "item/started",
              params: {
                threadId,
                turnId: "compact-turn",
                item: { id: "compact-item", type: "contextCompaction" },
              },
            });
            send({
              method: "item/completed",
              params: {
                threadId,
                turnId: "compact-turn",
                item: { id: "compact-item", type: "contextCompaction" },
              },
            });
            send({
              method: "turn/completed",
              params: { threadId, turn: { id: "compact-turn", status: "completed", items: [] } },
            });
            send({ id: request.id, result: {} });
          } else if (request.method === "thread/unsubscribe") {
            unsubscribed.push(request.params!.threadId);
            send({ id: request.id, result: {} });
          } else {
            throw new Error(`Unexpected retention fixture request: ${request.method}`);
          }
        },
      });
      vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(harness.client);
      try {
        const client = await getLeasedSharedCodexAppServerClient({ timeoutMs: 1000 });
        const pendingNotifications: Promise<void>[] = [];
        const addNotificationHandler = client.addNotificationHandler.bind(client);
        vi.spyOn(client, "addNotificationHandler").mockImplementation((handler) =>
          addNotificationHandler((notification) => {
            const pending = Promise.resolve(handler(notification));
            pendingNotifications.push(pending);
            return pending;
          }),
        );
        const notify = async (notification: CodexServerNotification) => {
          harness.send(notification);
          await Promise.all(pendingNotifications.splice(0));
        };
        const sessionFile = await writeCompactionTestBinding(tempRoot);
        expect(await retainCodexAppServerLiveThread(client, "thread-1")).toBe(true);
        expect(
          await maybeCompactCodexAppServerSession(
            {
              sessionId: "session-1",
              sessionKey: "agent:main:session-1",
              sessionFile,
              workspaceDir: tempRoot,
              trigger: "manual",
            },
            { clientFactory: async () => client },
          ),
        ).toMatchObject({ ok: true, compacted: true });

        expect(await retainCodexAppServerLiveThread(client, "parent-thread")).toBe(true);
        const parent = await codexNativeSubagentMonitorRuntime.register({
          client,
          parentThreadId: "parent-thread",
          requesterSessionKey: "agent:main:ordinary-parent",
          agentId: "main",
          modelSource: undefined,
          retainClient: () => retainSharedCodexAppServerClientIfCurrent(client),
          retainParentThread: (threadId) => protectCodexAppServerLiveThread(client, threadId),
        });
        await notify({
          method: "thread/started",
          params: {
            thread: {
              id: "child-thread",
              parentThreadId: "parent-thread",
              source: {
                subAgent: {
                  thread_spawn: { parent_thread_id: "parent-thread", depth: 1 },
                },
              },
            },
          },
        });
        await parent.unregister();
        const releaseReader = retainSharedCodexAppServerClientIfCurrent(client);
        expect(releaseReader).toBeDefined();
        expect(releaseLeasedSharedCodexAppServerClient(client)).toBe(true);
        expect(retireSharedCodexAppServerClientIfCurrent(client)).toEqual({
          activeLeases: 2,
          closed: false,
        });
        expect(harness.stdinDestroyed).toBe(false);

        const fillIdlePool = async (prefix: string) => {
          // Exceed the 64 idle-subscription bound without advancing recovery timers.
          for (let index = 0; index < 65; index++) {
            expect(await retainCodexAppServerLiveThread(client, `${prefix}-${index}`)).toBe(true);
          }
        };
        await fillIdlePool("during-child");
        expect(unsubscribed).toContain("thread-1");
        expect(unsubscribed).not.toContain("parent-thread");
        expect(hasCodexAppServerLiveThread(client, "parent-thread")).toBe(true);

        await notify({
          method: "turn/completed",
          params: {
            threadId: "child-thread",
            turn: {
              id: "child-turn",
              status: "completed",
              items: [
                {
                  id: "child-final",
                  type: "agentMessage",
                  phase: "final_answer",
                  text: "child final result",
                },
              ],
              error: null,
            },
          },
        });
        expect(retireSharedCodexAppServerClientIfCurrent(client)).toEqual({
          activeLeases: 1,
          closed: false,
        });
        await fillIdlePool("after-child");
        expect(unsubscribed.filter((threadId) => threadId === "parent-thread")).toHaveLength(1);
        expect(hasCodexAppServerLiveThread(client, "parent-thread")).toBe(false);

        const stdinClosed = once(harness.process.stdin, "close");
        releaseReader!();
        await stdinClosed;
        expect(harness.stdinDestroyed).toBe(true);
      } finally {
        await harness.client.closeAndWait();
        resetCodexTestBindingStore();
      }
    });
  });
}
