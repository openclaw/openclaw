import { once } from "node:events";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
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

async function exerciseRetention({ tempRoot }: { tempRoot: string }) {
  resetCodexTestBindingStore();
  setRuntimeConfigSnapshot({});
  const unsubscribed: string[] = [];
  const turn = { id: "compact-turn", status: "inProgress" };
  const item = { id: "compact-item", type: "contextCompaction" };
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
        send({ id: request.id, result: { userAgent: `codex-cli/${CODEX_APP_SERVER_VERSION}` } });
      } else if (request.method === "thread/compact/start") {
        const threadId = request.params?.threadId;
        send({ method: "turn/started", params: { threadId, turn } });
        const params = { threadId, turnId: turn.id, item };
        send({ method: "item/started", params });
        send({ method: "item/completed", params });
        send({
          method: "turn/completed",
          params: { threadId, turn: { ...turn, status: "completed", items: [] } },
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
    const notify = async (method: string, params: CodexServerNotification["params"]) => {
      harness.send({ method, params });
      await Promise.all(pendingNotifications.splice(0));
    };
    const sessionFile = await writeBinding(tempRoot);
    expect(await retainThread(client, "thread-1")).toBe(true);
    expect(
      await compact(
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
    await notify("thread/started", {
      thread: {
        id: "child-thread",
        parentThreadId: "parent-thread",
        source: { subAgent: { thread_spawn: { parent_thread_id: "parent-thread", depth: 1 } } },
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

    await notify("turn/completed", {
      threadId: "child-thread",
      turn: {
        id: "child-turn",
        status: "completed",
        items: [{ id: "final", type: "agentMessage", phase: "final_answer", text: "done" }],
        error: null,
      },
    });
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
    clearRuntimeConfigSnapshot();
  }
}

/** The registering suite owns auth mocks and shared-client cleanup. */
export function registerSharedClientCompactionRetentionTests() {
  it("retains ordinary native children when compaction created the cached monitor first", () =>
    withStateDirEnv("openclaw-codex-compaction-retention-", exerciseRetention));
}
