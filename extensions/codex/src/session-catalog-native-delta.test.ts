import { setImmediate as nextTurn } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as terminalText from "openclaw/plugin-sdk/text-chunking";
import { expect, it, vi } from "vitest";
import type { CodexThreadListResponse } from "./app-server/protocol.js";
import { createClientHarness } from "./app-server/test-support.js";
import { observeCodexCatalogClient } from "./session-catalog-events.js";
import {
  commandRpcMocks,
  createCodexSessionCatalogControlFactory,
  idleThread,
} from "./session-catalog.test-helpers.js";

it("reconciles remote membership without reparsing unchanged visible or hidden previews", async () => {
  const known = idleThread({
    id: "known",
    name: "Previous title",
    preview: "Retained first user request",
    path: "/remote/sessions/known.jsonl",
    updatedAt: 100,
    recencyAt: 100,
    source: "cli",
    status: { type: "active", activeFlags: ["waitingOnApproval"] },
  });
  const changed = idleThread({
    id: "changed",
    name: null,
    preview: "Previous request",
    updatedAt: 100,
    recencyAt: 100,
    source: "cli",
  });
  const hidden = idleThread({
    id: "hidden",
    source: "exec",
    preview: "Hidden native execution",
    updatedAt: 100,
    recencyAt: 100,
  });
  let native = [known, changed, idleThread({ id: "removed", source: "cli" }), hidden];
  commandRpcMocks.codexControlRequest.mockImplementation(
    async (_plugin, method, params, options) => {
      expect(method).toBe("thread/list");
      if (params.useStateDbOnly) {
        expect(options).toHaveProperty("catalogPreview", true);
      }
      return { data: native } satisfies CodexThreadListResponse;
    },
  );
  const factory = createCodexSessionCatalogControlFactory({
    getPluginConfig: () => ({
      appServer: {
        transport: "websocket",
        url: "wss://remote-catalog.example.test/codex",
        authToken: "synthetic-remote-catalog-token",
      },
    }),
    getRuntimeConfig: () => undefined,
  });
  const source = (await factory.homesForAgent("main"))[0]!;
  expect(source.localSessionsRoot).toBeUndefined();
  const control = factory.forRequest("main", source);
  const preview = vi.fn(() => {
    throw new Error("Unchanged resident rows must not reparse native previews");
  });
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  try {
    await control.initialize();
    expect((await control.listPage({})).sessions.map((row) => row.threadId).toSorted()).toEqual([
      "changed",
      "known",
      "removed",
    ]);
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledOnce();
    const knownPreview = known.preview;
    const sanitize = vi.spyOn(terminalText, "sanitizeTerminalText");
    Object.defineProperty(known, "preview", { get: () => knownPreview });
    Object.defineProperty(hidden, "preview", { get: preview });
    known.name = null;
    known.status = { type: "idle" };
    known.path = `${known.path}.zst`;
    changed.preview = "Changed user request";
    changed.updatedAt = 200;
    changed.recencyAt = 200;
    const created = idleThread({
      id: "created",
      name: null,
      source: "cli",
      preview: "New independent native task",
      updatedAt: 300,
      recencyAt: 300,
    });
    native = [created, changed, known, hidden];
    expect((await control.listPage({})).sessions.map((row) => row.threadId).toSorted()).toEqual([
      "changed",
      "known",
      "removed",
    ]);
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await vi.waitFor(async () => {
      const sessions = (await control.listPage({})).sessions;
      expect(sessions.map((row) => row.threadId).toSorted()).toEqual([
        "changed",
        "created",
        "known",
      ]);
      expect(sessions.find((row) => row.threadId === "known")).toMatchObject({
        name: null,
        fallbackName: "Retained first user request",
        status: "idle",
      });
      expect(sessions.find((row) => row.threadId === "known")).not.toHaveProperty("activeFlags");
      expect(sessions.find((row) => row.threadId === "changed")?.fallbackName).toBe(
        "Changed user request",
      );
      expect(sessions.find((row) => row.threadId === "created")?.fallbackName).toBe(
        "New independent native task",
      );
    });
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2);
    expect(commandRpcMocks.codexControlRequest.mock.calls[1]?.[2]).toMatchObject({
      useStateDbOnly: true,
    });
    expect(preview).not.toHaveBeenCalled();
    expect(sanitize.mock.calls.map(([value]) => value)).not.toContain(knownPreview);
  } finally {
    try {
      await factory.stop();
    } finally {
      vi.useRealTimers();
    }
  }
});

it("walks remote pages beyond the resident bound without projecting the uncached tail", async () => {
  const native = Array.from({ length: 20_001 }, (_, index) =>
    idleThread({
      id: `bounded-thread-${index}`,
      source: index === 20_000 ? "exec" : "cli",
      preview: `Synthetic first user request ${index}`,
      updatedAt: 100,
      recencyAt: 100,
    }),
  );
  const lastPage = createDeferred<void>();
  commandRpcMocks.codexControlRequest.mockImplementation(async (_plugin, method, params) => {
    expect(method).toBe("thread/list");
    const offset = Number(params.cursor ?? 0);
    const data = native.slice(offset, offset + 64);
    const nextCursor = offset + data.length < native.length ? String(offset + data.length) : null;
    if (params.useStateDbOnly && nextCursor === null) {
      lastPage.resolve();
    }
    return { data, nextCursor } satisfies CodexThreadListResponse;
  });
  const factory = createCodexSessionCatalogControlFactory({
    getPluginConfig: () => ({
      appServer: {
        transport: "websocket",
        url: "wss://bounded-remote-catalog.example.test/codex",
        authToken: "synthetic-bounded-catalog-token",
      },
    }),
    getRuntimeConfig: () => undefined,
  });
  const source = (await factory.homesForAgent("main"))[0]!;
  const control = factory.forRequest("main", source);
  const tailPreview = vi.fn(() => {
    throw new Error("Uncached native tail must not be projected on each refresh");
  });
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  try {
    await control.initialize();
    const first = await control.listPage({ limit: 64 });
    expect(first.sessions.map((row) => row.threadId)).toEqual(
      native.slice(0, 64).map((thread) => thread.id),
    );
    const pages = Math.ceil(native.length / 64);
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(pages);
    Object.defineProperty(native[20_000]!, "preview", { get: tailPreview });
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await lastPage.promise;
    const refreshed = await control.listPage({ limit: 64 });
    await factory.stop();
    expect(refreshed).toEqual(first);
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(pages * 2);
    expect(tailPreview).not.toHaveBeenCalled();
  } finally {
    try {
      await factory.stop();
    } finally {
      vi.useRealTimers();
    }
  }
});

it("reconciles displayed native metadata and explicit Git clears without activity or file changes", async () => {
  const native = Object.assign(
    idleThread({
      id: "metadata",
      name: "Unchanged title",
      source: "cli",
      cwd: "/workspace/project",
      createdAt: 10,
      updatedAt: 100,
      recencyAt: 100,
      sessionId: "previous-session",
    }),
    { cliVersion: "0.154.0", gitInfo: { branch: "previous-branch" } },
  );
  commandRpcMocks.codexControlRequest.mockImplementation(async (_plugin, method, params) => {
    expect(method).toBe("thread/list");
    if (commandRpcMocks.codexControlRequest.mock.calls.length > 1) {
      expect(params.useStateDbOnly).toBe(true);
    }
    return { data: [native] };
  });
  const factory = createCodexSessionCatalogControlFactory({
    getPluginConfig: () => ({ supervision: { enabled: true } }),
    getRuntimeConfig: () => undefined,
  });
  const source = (await factory.homesForAgent("main"))[0]!;
  const control = factory.forRequest("main", source);
  const client = createClientHarness();
  const nativeRead = vi.spyOn(client.client, "request");
  const requested = createDeferred<void>();
  const release = createDeferred<void>();
  await observeCodexCatalogClient(client.client, {
    startOptions: source.appServer.start,
    agentDir: source.agentDir,
  });
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  try {
    await control.initialize();
    expect((await control.listPage({})).sessions[0]).toMatchObject({
      gitBranch: "previous-branch",
    });
    // Native paginated metadata updates leave activity timestamps and rollouts untouched.
    Object.assign(native, {
      gitInfo: { branch: "updated-branch" },
      cliVersion: "0.155.0",
      modelProvider: "updated-provider",
      createdAt: 20,
      sessionId: "current-session",
      source: "vscode",
    });
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await vi.waitFor(async () => {
      expect((await control.listPage({})).sessions[0]).toMatchObject({
        gitBranch: "updated-branch",
        cliVersion: "0.155.0",
        modelProvider: "updated-provider",
        createdAt: 20,
        sessionId: "current-session",
        source: "vscode",
        updatedAt: 100,
        recencyAt: 100,
      });
    });
    Object.assign(native, { gitInfo: null });
    await vi.waitFor(() => expect(factory.hasActiveWork()).toBe(false));
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await vi.waitFor(async () => {
      expect((await control.listPage({})).sessions[0]).not.toHaveProperty("gitBranch");
    });
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(3);
    await vi.waitFor(() => expect(factory.hasActiveWork()).toBe(false));
    const older = structuredClone(native);
    commandRpcMocks.codexControlRequest.mockImplementationOnce(async () => {
      requested.resolve();
      await release.promise;
      return { data: [older] };
    });
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await requested.promise;
    client.send({ method: "turn/completed", params: { threadId: native.id, turn: {} } });
    const request = JSON.parse(await client.waitForWrite(0));
    expect(request.method).toBe("thread/read");
    client.send({
      id: request.id,
      result: { thread: { ...native, gitInfo: { branch: "newer-completion" } } },
    });
    await nativeRead.mock.results[0]!.value;
    await vi.waitFor(async () => {
      expect((await control.listPage({})).sessions[0]?.gitBranch).toBe("newer-completion");
    });
    release.resolve();
    await nextTurn();
    expect((await control.listPage({})).sessions[0]?.gitBranch).toBe("newer-completion");
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(4);
  } finally {
    release.resolve();
    await client.client.closeAndWait();
    await factory.stop();
    vi.useRealTimers();
  }
});
