import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as terminalText from "openclaw/plugin-sdk/text-chunking";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CodexThread, CodexThreadListResponse } from "./app-server/protocol.js";
import { catalogFactory, remoteCatalogFactory } from "./session-catalog-resident.test-support.js";
import { commandRpcMocks, idleThread } from "./session-catalog.test-helpers.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
});
afterEach(() => {
  vi.useRealTimers();
});

const nativeThread = (overrides: Partial<CodexThread>) =>
  idleThread({ source: "cli", updatedAt: 100, recencyAt: 100, ...overrides });

it("reconciles remote membership without reparsing unchanged visible or hidden previews", async () => {
  const known = nativeThread({
    id: "known",
    name: "Previous title",
    preview: "Retained first user request",
    path: "/remote/sessions/known.jsonl",
    status: { type: "active", activeFlags: ["waitingOnApproval"] },
  });
  const changed = nativeThread({
    id: "changed",
    name: null,
    preview: "Previous request",
  });
  const hidden = nativeThread({
    id: "hidden",
    source: "exec",
    preview: "Hidden native execution",
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
  const factory = remoteCatalogFactory("remote-catalog");
  const source = (await factory.homesForAgent("main"))[0]!;
  expect(source.localSessionsRoot).toBeUndefined();
  const control = factory.forRequest("main", source);
  try {
    await control.initialize();
    const initial = await control.listPage({});
    expect(initial.sessions.map((row) => row.threadId).toSorted()).toEqual([
      "changed",
      "known",
      "removed",
    ]);
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledOnce();
    const knownPreview = known.preview;
    const sanitize = vi.spyOn(terminalText, "sanitizeTerminalText");
    Object.defineProperty(known, "preview", { get: () => knownPreview });
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
    expect(await control.listPage({})).toEqual(initial);
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await vi.waitFor(async () => {
      const sessions = (await control.listPage({})).sessions;
      expect(sessions.toSorted((a, b) => a.threadId.localeCompare(b.threadId))).toMatchObject([
        { threadId: "changed", fallbackName: "Changed user request" },
        { threadId: "created", fallbackName: "New independent native task" },
        {
          threadId: "known",
          name: null,
          fallbackName: "Retained first user request",
          status: "idle",
        },
      ]);
      expect(sessions.find((row) => row.threadId === "known")).not.toHaveProperty("activeFlags");
    });
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2);
    expect(commandRpcMocks.codexControlRequest.mock.calls[1]?.[2]).toMatchObject({
      useStateDbOnly: true,
    });
    expect(sanitize.mock.calls.map(([value]) => value)).not.toContain(knownPreview);
    expect(sanitize.mock.calls.map(([value]) => value)).not.toContain("Hidden native execution");
    await vi.waitFor(() => expect(factory.hasActiveWork()).toBe(false));
    sanitize.mockClear();
    const renamed = "Offline title ".repeat(60).trim();
    known.name = renamed;
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await vi.waitFor(async () => {
      const current = (await control.listPage({})).sessions.find(
        (row) => row.threadId === known.id,
      );
      expect(current?.name).toBe(renamed.slice(0, 500));
    });
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(3);
    expect(sanitize).not.toHaveBeenCalled();
  } finally {
    await factory.stop();
  }
});

it("walks remote pages beyond the resident bound without projecting the uncached tail", async () => {
  const native = Array.from({ length: 20_001 }, (_, index) =>
    nativeThread({
      id: `bounded-thread-${index}`,
      source: index === 20_000 ? "exec" : "cli",
      preview: `Synthetic first user request ${index}`,
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
  const factory = remoteCatalogFactory("bounded-remote-catalog");
  const source = (await factory.homesForAgent("main"))[0]!;
  const control = factory.forRequest("main", source);
  const tailPreview = vi.fn(() => {
    throw new Error("Uncached native tail must not be projected on each refresh");
  });
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
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(pages);
    await control.listPage({ cwd: "/workspace/project", limit: 64 });
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(pages + 1);
    await control.listPage({ limit: 64 });
    await lastPage.promise;
    const refreshed = await control.listPage({ limit: 64 });
    await factory.stop();
    expect(refreshed).toEqual(first);
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(pages * 2 + 1);
    expect(tailPreview).not.toHaveBeenCalled();
  } finally {
    await factory.stop();
  }
});

it("reconciles displayed native metadata and explicit Git clears without activity or file changes", async () => {
  const native = Object.assign(
    nativeThread({
      id: "metadata",
      name: "Unchanged title",
      cwd: "/workspace/project",
      createdAt: 10,
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
  const factory = catalogFactory();
  const source = (await factory.homesForAgent("main"))[0]!;
  const control = factory.forRequest("main", source);
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
  } finally {
    await factory.stop();
  }
});
