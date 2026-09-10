import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexAppServerAgentHarness } from "./harness.js";
import { resolveCodexBindingAppServerConnection } from "./src/app-server/binding-connection.js";
import {
  buildCodexAppServerConnectionFingerprint,
  buildCodexAppServerRuntimeFingerprint,
} from "./src/app-server/plugin-app-cache-key.js";
import type { CodexThread, CodexThreadItem } from "./src/app-server/protocol.js";
import {
  createCodexTestBindingStore,
  sessionBindingIdentity,
  type CodexAppServerThreadBinding,
} from "./src/app-server/session-binding.test-helpers.js";

const native = vi.hoisted(() => ({
  request: vi.fn<(method: string, params: Record<string, unknown>) => Promise<unknown>>(),
  acquire: vi.fn(),
  release: vi.fn(),
  version: "0.153.4",
  home: "/synthetic/codex-home",
}));
vi.mock("./src/app-server/shared-client.js", () => ({
  getLeasedSharedCodexAppServerClient: native.acquire,
  releaseLeasedSharedCodexAppServerClient: native.release,
}));

const directories: string[] = [];
beforeEach(() => {
  native.request.mockReset();
  native.acquire.mockReset().mockResolvedValue({
    request: native.request,
    getServerVersion: () => native.version,
    getRuntimeIdentity: () => ({ serverVersion: native.version, codexHome: native.home }),
  });
  native.release.mockReset();
});
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

type ReadParams = Parameters<NonNullable<AgentHarnessV2["taskHistory"]>["read"]>[0];
function messageIds(messages: unknown[]) {
  return messages.map((message) => asOptionalRecord(message)?.messageId);
}

function item(id: string, overrides: Partial<CodexThreadItem>): CodexThreadItem {
  return {
    id,
    type: "agentMessage",
    title: null,
    status: null,
    name: null,
    tool: null,
    server: null,
    command: null,
    cwd: null,
    query: null,
    aggregatedOutput: null,
    text: "",
    changes: [],
    ...overrides,
  };
}

async function fixture(supervised = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-history-"));
  directories.push(directory);
  const agentDir = path.join(directory, "agent");
  const storePath = path.join(directory, "sessions.json");
  const cfg: OpenClawConfig = {
    session: { store: storePath },
    agents: { entries: { main: { agentDir } } },
  };
  const session = { agentId: "main", sessionId: "parent-session", sessionKey: "agent:main:parent" };
  await upsertSessionEntry({
    agentId: session.agentId,
    sessionKey: session.sessionKey,
    storePath,
    entry: { sessionId: session.sessionId, updatedAt: 1 },
  });
  const bindingStore = createCodexTestBindingStore();
  const pluginConfig = supervised ? { supervision: { enabled: true } } : undefined;
  const connection = resolveCodexBindingAppServerConnection({ pluginConfig, agentDir });
  let binding: CodexAppServerThreadBinding = {
    threadId: "parent-thread",
    cwd: directory,
    appServerRuntimeFingerprint: buildCodexAppServerRuntimeFingerprint({
      appServer: connection.appServer,
      appServerVersion: native.version,
      runtimeIdentity: { serverVersion: native.version, codexHome: native.home },
    }),
  };
  if (supervised) {
    const { resolveCodexSupervisionAppServerRuntimeOptions } =
      await import("./src/app-server/config.js");
    binding = {
      ...binding,
      connectionScope: "supervision",
      supervisionSourceThreadId: "source",
      preserveNativeModel: true,
      conversationSourceTransferComplete: true,
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      appServerRuntimeFingerprint: buildCodexAppServerConnectionFingerprint(
        resolveCodexSupervisionAppServerRuntimeOptions({ pluginConfig, agentDir }),
        agentDir,
      ),
    };
  }
  const identity = sessionBindingIdentity(session);
  await bindingStore.mutate(identity, { kind: "set", binding });
  const harness = createCodexAppServerAgentHarness({ bindingStore, pluginConfig });
  const params: ReadParams = {
    cfg,
    task: {
      taskId: "task-1",
      runtime: "subagent",
      taskKind: "codex-native",
      requesterSessionKey: session.sessionKey,
      agentId: "main",
      runId: "codex-thread:child-thread",
      ownerKey: "main",
      scopeKind: "session",
      task: "Inspect code",
      status: "running",
      deliveryStatus: "pending",
      notifyPolicy: "done_only",
      createdAt: 1,
    },
    limit: 100,
    assertCurrent: vi.fn(),
  };
  const thread: CodexThread = {
    id: "child-thread",
    projectId: null,
    createdAt: 123,
    historyMode: "paginated",
    source: { subAgent: { thread_spawn: { parent_thread_id: "parent-thread" } } },
  };
  const threads = new Map([[thread.id, thread]]);
  const items: CodexThreadItem[] = [];
  native.request.mockImplementation(async (method, request) => {
    if (method === "thread/read") {
      const selected = threads.get(String(request.threadId));
      if (!selected) {
        throw new Error("Thread is unavailable");
      }
      return { thread: selected };
    }
    if (method === "thread/items/list") {
      const newest = items.toReversed();
      const offset = request.cursor
        ? newest.findIndex((entry) => entry.id === request.cursor) + 1
        : 0;
      const selected = newest.slice(offset, offset + Number(request.limit));
      return {
        data: selected.map((entry) => ({ turnId: "turn-1", item: entry })),
        ...(offset + selected.length < newest.length ? { nextCursor: selected.at(-1)?.id } : {}),
      };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  return {
    params,
    items,
    thread,
    threads,
    binding,
    bindingStore,
    identity,
    storePath,
    harness,
    read: (overrides: Partial<ReadParams> = {}) =>
      harness.taskHistory!.read({ ...params, ...overrides }),
  };
}

describe("native subagent history through the harness", () => {
  it("renders user, reasoning, tool call/result, and active assistant content in chronological order", async () => {
    const f = await fixture();
    f.items.push(
      item("user", { type: "userMessage", content: [{ type: "text", text: "Check this" }] }),
      item("thinking", { type: "reasoning", summary: ["Inspecting the code"] }),
      item("command", {
        type: "commandExecution",
        command: "pwd",
        aggregatedOutput: "/workspace",
        status: "completed",
        exitCode: 0,
      }),
      item("assistant", { text: "Working on it", phase: "commentary" }),
    );
    const page = await f.read();
    expect(page.messages).toMatchObject([
      { role: "user", content: "Check this" },
      { role: "assistant", content: [{ type: "thinking", thinking: "Inspecting the code" }] },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "command", name: "bash", arguments: { command: "pwd" } }],
      },
      {
        role: "toolResult",
        toolCallId: "command",
        content: [{ type: "text", text: "/workspace" }],
        isError: false,
      },
      { role: "assistant", content: [{ type: "text", text: "Working on it" }] },
    ]);
    const ids = messageIds(page.messages);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(page.messages.length);
    expect(native.acquire).toHaveBeenCalledWith(
      expect.objectContaining({ agentDir: expect.any(String) }),
    );
    expect(native.release).toHaveBeenCalledOnce();
    f.items[2]!.aggregatedOutput = "/workspace/updated";
    const updated = await f.read();
    expect(messageIds(updated.messages)).toEqual(ids);
    expect(updated.messages).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        toolCallId: "command",
        content: [{ type: "text", text: "/workspace/updated" }],
      }),
    );
  });

  it("paginates older messages without replay or loss after a live append", async () => {
    const f = await fixture();
    f.items.push(
      ...Array.from({ length: 7 }, (_, index) =>
        item(`item-${index}`, { text: `message ${index}` }),
      ),
    );
    const first = await f.read({ limit: 6 });
    f.items.push(item("new", { text: "new live message" }));
    const second = await f.read({ limit: 4, cursor: first.nextCursor });
    const third = await f.read({ limit: 6, cursor: second.nextCursor });
    expect([...third.messages, ...second.messages, ...first.messages]).toEqual(
      Array.from({ length: 7 }, (_, index) =>
        expect.objectContaining({
          role: "assistant",
          content: [{ type: "text", text: `message ${index}` }],
        }),
      ),
    );
    expect(third.nextCursor).toBeUndefined();
    const full = await f.read();
    expect(full.messages).toContainEqual(
      expect.objectContaining({
        content: [{ type: "text", text: "new live message" }],
      }),
    );
    expect(messageIds([...third.messages, ...second.messages, ...first.messages])).toEqual(
      messageIds(full.messages.slice(0, -1)),
    );
    f.items[5]!.text = "Updated content for the same native item";
    const refreshed = await f.read();
    expect(messageIds(refreshed.messages)).toEqual(messageIds(full.messages));
    expect(refreshed.messages).toContainEqual(
      expect.objectContaining({
        content: [{ type: "text", text: "Updated content for the same native item" }],
      }),
    );
  });

  it.each([false, true])(
    "reconnects the binding-owned store (supervision=%s)",
    async (supervised) => {
      const f = await fixture(supervised);
      f.items.push(item("answer", { text: "Stored child history" }));
      expect((await f.read()).messages).toMatchObject([
        { content: [{ text: "Stored child history" }] },
      ]);
      expect(native.acquire).toHaveBeenCalledWith(
        expect.objectContaining({
          authProfileId: supervised ? null : undefined,
          startOptions: expect.objectContaining({ homeScope: supervised ? "user" : "agent" }),
        }),
      );
    },
  );

  it("reads nested subagents only after metadata verifies every ancestor back to the bound parent", async () => {
    const f = await fixture();
    f.thread.parentThreadId = "worker-2";
    f.threads.set("worker-2", {
      id: "worker-2",
      projectId: null,
      source: { subAgent: { thread_spawn: { parent_thread_id: "worker-1" } } },
    });
    f.threads.set("worker-1", { id: "worker-1", projectId: null, parentThreadId: "parent-thread" });
    f.items.push(item("answer", { text: "Nested work" }));
    expect((await f.read()).messages).toMatchObject([{ content: [{ text: "Nested work" }] }]);
    expect(
      native.request.mock.calls.map(([method, params]) => [
        method,
        params.threadId,
        params.includeTurns,
      ]),
    ).toEqual([
      ["thread/read", "child-thread", false],
      ["thread/read", "worker-2", false],
      ["thread/read", "worker-1", false],
      ["thread/items/list", "child-thread", undefined],
    ]);
  });

  it.each(["cycle", "foreign root", "missing ancestor", "mismatched ancestor", "excessive depth"])(
    "rejects %s before reading any history",
    async (failure) => {
      const f = await fixture();
      f.thread.parentThreadId = "worker-1";
      if (failure !== "missing ancestor") {
        f.threads.set("worker-1", {
          id: failure === "mismatched ancestor" ? "different-worker" : "worker-1",
          projectId: null,
          ...(failure === "cycle" ? { parentThreadId: "child-thread" } : {}),
        });
      }
      if (failure === "excessive depth") {
        for (let depth = 1; depth < 40; depth++) {
          f.threads.set(`worker-${depth}`, {
            id: `worker-${depth}`,
            projectId: null,
            parentThreadId: `worker-${depth + 1}`,
          });
        }
      }
      await expect(f.read()).rejects.toThrow(
        failure === "missing ancestor" ? "unavailable" : "does not belong",
      );
      expect(
        native.request.mock.calls.every(
          ([method, params]) => method === "thread/read" && params.includeTurns === false,
        ),
      ).toBe(true);
      expect(native.request.mock.calls.length).toBeLessThanOrEqual(32);
      expect(native.release).toHaveBeenCalledOnce();
    },
  );

  it("rechecks the parent binding after awaiting ancestor metadata", async () => {
    const f = await fixture();
    f.thread.parentThreadId = "worker-1";
    f.threads.set("worker-1", { id: "worker-1", projectId: null, parentThreadId: "parent-thread" });
    const request = native.request.getMockImplementation()!;
    native.request.mockImplementation(async (method, params) => {
      const result = await request(method, params);
      if (method === "thread/read" && params.threadId === "worker-1") {
        await f.bindingStore.mutate(f.identity, {
          kind: "patch",
          threadId: "parent-thread",
          patch: { appServerRuntimeFingerprint: "changed" },
        });
      }
      return result;
    });
    await expect(f.read()).rejects.toThrow("parent changed");
    expect(native.request.mock.calls.map(([method]) => method)).toEqual([
      "thread/read",
      "thread/read",
    ]);
    expect(native.release).toHaveBeenCalledOnce();
  });

  it("rejects copied thread ids from a different native store", async () => {
    const f = await fixture();
    native.acquire.mockResolvedValueOnce({
      request: native.request,
      getServerVersion: () => native.version,
      getRuntimeIdentity: () => ({ serverVersion: native.version, codexHome: "/other/home" }),
    });
    await expect(f.read()).rejects.toThrow("connection changed");
    expect(native.request).not.toHaveBeenCalled();
    expect(native.release).toHaveBeenCalledOnce();
  });

  it("rejects an awaited page after the harness is disposed", async () => {
    const f = await fixture();
    f.items.push(item("answer", { text: "Pending result" }));
    const request = native.request.getMockImplementation()!;
    native.request.mockImplementation(async (method, params) => {
      const result = await request(method, params);
      if (method === "thread/items/list") {
        await f.harness.dispose?.();
      }
      return result;
    });
    await expect(f.read()).rejects.toThrow("harness is disposed");
    expect(native.release).toHaveBeenCalledOnce();
  });

  it("rechecks the physical parent session after awaited history reads", async () => {
    const f = await fixture();
    const request = native.request.getMockImplementation()!;
    native.request.mockImplementation(async (method, params) => {
      const result = await request(method, params);
      if (method === "thread/items/list") {
        await upsertSessionEntry({
          agentId: "main",
          sessionKey: f.params.task.requesterSessionKey,
          storePath: f.storePath,
          entry: { sessionId: "replacement-session", updatedAt: 2 },
        });
      }
      return result;
    });
    await expect(f.read()).rejects.toThrow("parent changed");
    expect(native.release).toHaveBeenCalledOnce();
  });
});
