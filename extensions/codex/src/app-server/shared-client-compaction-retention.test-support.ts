import { once } from "node:events";
import * as configSnapshot from "openclaw/plugin-sdk/runtime-config-snapshot";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { expect, it, vi } from "vitest";
import {
  hasCodexAppServerLiveThread as hasThread,
  protectCodexAppServerLiveThread as protectThread,
  retainCodexAppServerLiveThread as retainThread,
} from "./client-runtime.js";
import { CodexAppServerClient as Client } from "./client.js";
import {
  maybeCompactCodexAppServerSession as compact,
  writeCompactionTestBinding as writeBinding,
} from "./compact.test-support.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import { childTurnCompletedNotification } from "./native-subagent-monitor.test-support.js";
import type { CodexServerNotification } from "./protocol.js";
import { resetCodexTestBindingStore } from "./session-binding.test-helpers.js";
import {
  getLeasedSharedCodexAppServerClient as acquire,
  releaseLeasedSharedCodexAppServerClient as release,
  retainSharedCodexAppServerClientIfCurrent as retain,
  retireSharedCodexAppServerClientIfCurrent as retire,
} from "./shared-client.js";
import { createClientHarness } from "./test-support.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

type Request = { id?: number; method: string; params?: { threadId: string } };
async function exerciseRetention({ tempRoot }: { tempRoot: string }) {
  resetCodexTestBindingStore();
  configSnapshot.setRuntimeConfigSnapshot({});
  const unsubscribed: string[] = [];
  const turn = { id: "compact-turn", status: "inProgress" };
  const item = { id: "compact-item", type: "contextCompaction" };
  const final = [{ id: "final", type: "agentMessage", phase: "final_answer", text: "done" }];
  const harness = createClientHarness({
    onWrite(line, send) {
      const { id, method, params } = JSON.parse(line) as Request;
      if (id === undefined) {
        return;
      }
      let result: { userAgent?: string } = {};
      if (method === "initialize") {
        result = { userAgent: `codex-cli/${CODEX_APP_SERVER_VERSION}` };
      } else if (method === "thread/compact/start") {
        const threadId = params?.threadId;
        send({ method: "turn/started", params: { threadId, turn } });
        const itemParams = { threadId, turnId: turn.id, item };
        send({ method: "item/started", params: itemParams });
        send({ method: "item/completed", params: itemParams });
        send({
          method: "turn/completed",
          params: { threadId, turn: { ...turn, status: "completed", items: [] } },
        });
      } else if (method === "thread/unsubscribe") {
        unsubscribed.push(params!.threadId);
      } else {
        throw new Error(`Unexpected retention fixture request: ${method}`);
      }
      send({ id, result });
    },
  });
  vi.spyOn(Client, "start").mockResolvedValueOnce(harness.client);
  try {
    const client = await acquire({ timeoutMs: 1000 });
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
    expect(await retainThread(client, "thread-1")).toBe(true);
    const result = await compact(
      {
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        sessionFile: await writeBinding(tempRoot),
        workspaceDir: tempRoot,
        trigger: "manual",
      },
      { clientFactory: async () => client },
    );
    expect(result).toMatchObject({ ok: true, compacted: true });
    expect(await retainThread(client, "parent-thread")).toBe(true);
    const parent = await codexNativeSubagentMonitorRuntime.register({
      client,
      parentThreadId: "parent-thread",
      requesterSessionKey: "agent:main:ordinary-parent",
      agentId: "main",
      modelSource: undefined,
      retainClient: () => retain(client),
      retainParentThread: (threadId) => protectThread(client, threadId),
    });
    await notify({
      method: "thread/started",
      params: {
        thread: {
          id: "child-thread",
          parentThreadId: "parent-thread",
          source: { subAgent: { thread_spawn: { parent_thread_id: "parent-thread", depth: 1 } } },
        },
      },
    });
    await parent.unregister();
    const releaseReader = retain(client);
    expect(releaseReader).toBeDefined();
    expect(release(client)).toBe(true);
    expect(retire(client)).toEqual({ activeLeases: 2, closed: false });
    expect(harness.stdinDestroyed).toBe(false);

    const fillIdlePool = async (prefix: string) => {
      // Exceed the 64 idle-subscription bound without advancing recovery timers.
      for (let index = 0; index < 65; index++) {
        expect(await retainThread(client, `${prefix}-${index}`)).toBe(true);
      }
    };
    await fillIdlePool("during-child");
    expect(unsubscribed).toContain("thread-1");
    expect(unsubscribed).not.toContain("parent-thread");
    expect(hasThread(client, "parent-thread")).toBe(true);

    await notify(childTurnCompletedNotification({ status: "completed", items: final }));
    expect(retire(client)).toEqual({ activeLeases: 1, closed: false });
    await fillIdlePool("after-child");
    expect(unsubscribed.filter((threadId) => threadId === "parent-thread")).toHaveLength(1);
    expect(hasThread(client, "parent-thread")).toBe(false);

    const stdinClosed = once(harness.process.stdin, "close");
    releaseReader!();
    await stdinClosed;
    expect(harness.stdinDestroyed).toBe(true);
  } finally {
    await harness.client.closeAndWait();
    resetCodexTestBindingStore();
    configSnapshot.clearRuntimeConfigSnapshot();
  }
}

/** The registering suite owns auth mocks and shared-client cleanup. */
export function registerSharedClientCompactionRetentionTests() {
  it("retains ordinary native children when compaction created the cached monitor first", () =>
    withStateDirEnv("openclaw-codex-compaction-retention-", exerciseRetention));
}
