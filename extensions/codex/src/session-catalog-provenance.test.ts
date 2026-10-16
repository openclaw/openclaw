import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isOpenClawManagedCodexThread } from "./session-catalog-provenance.js";
import {
  config,
  idleThread,
  commandRpcMocks,
  pinnedConnectionMocks,
  createCodexSessionCatalogControlFactory as createCodexSessionCatalogControl,
  createRuntime,
  createGatewayApi,
  registerCodexSessionCatalog,
  createCodexTestBindingStore,
  createCodexSessionCatalogNodeHostCommands,
  CODEX_TERMINAL_RESUME_COMMAND,
  nodeHostMocks,
  withEnvAsync,
} from "./session-catalog.test-helpers.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function writeRollout(payload: Record<string, unknown>): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-provenance-"));
  temporaryDirectories.push(directory);
  const file = path.join(directory, "rollout.jsonl");
  await fs.writeFile(file, `${JSON.stringify({ type: "session_meta", payload })}\n`);
  return file;
}

describe("Codex catalog provenance", () => {
  it("does not seed rollout provenance cache from an API-only result", async () => {
    const file = await writeRollout({ id: "uncached-originator", originator: "codex_cli_rs" });
    const thread = idleThread({ id: "uncached-originator", path: file, originator: "openclaw" });
    await expect(isOpenClawManagedCodexThread(thread, path.dirname(file))).resolves.toBe(true);
    await expect(
      isOpenClawManagedCodexThread({ ...thread, originator: null }, path.dirname(file)),
    ).resolves.toBe(false);
  });

  it("requires a selected local sessions root even for API provenance", async () => {
    await expect(
      isOpenClawManagedCodexThread(
        idleThread({ path: "/outside/rollout.jsonl", originator: "openclaw" }),
        undefined,
      ),
    ).resolves.toBe(false);
  });

  it.each([false])(
    "settles compressed read failures and preserves recovery (plain fallback=%s)",
    async (plainFallback) => {
      const threadId = `compressed-read-failure-${plainFallback}`;
      const file = await writeRollout({ id: threadId, originator: "openclaw", source: "vscode" });
      const compressed = `${file}.zst`;
      await fs.writeFile(compressed, zstdCompressSync(await fs.readFile(file)));
      if (!plainFallback) {
        await fs.rm(file);
      }
      const compressedPaths = new Set([compressed, await fs.realpath(compressed)]);
      const open = fs.open.bind(fs);
      let failedHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
      const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (typeof args[0] === "string" && compressedPaths.has(args[0])) {
          failedHandle = handle;
          const createReadStream = handle.createReadStream.bind(handle);
          vi.spyOn(handle, "createReadStream").mockImplementationOnce((options) => {
            const stream = createReadStream(options);
            stream.destroy(new Error("rollout source read failed"));
            return stream;
          });
        }
        return handle;
      });
      const thread = idleThread({ id: threadId, path: compressed });
      try {
        await expect(isOpenClawManagedCodexThread(thread, path.dirname(file))).resolves.toBe(
          plainFallback,
        );
      } finally {
        openSpy.mockRestore();
      }
      expect(failedHandle?.fd).toBe(-1);
      // An unreadable rollout supplies no durable negative provenance.
      await expect(isOpenClawManagedCodexThread(thread, path.dirname(file))).resolves.toBe(true);
    },
  );
});

// Filesystem cases use the production budget; clock-driven cases select their own deadline.
async function localEligibilityFixture(now = () => 0, requestTimeoutMs?: number) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-eligibility-")));
  temporaryDirectories.push(home);
  const root = path.join(home, "sessions");
  await fs.mkdir(root);
  const rollout = path.join(root, "source.jsonl");
  const metadata = {
    id: "12345678-1234-1234-1234-123456789abc",
    source: "cli",
    originator: "codex_cli_rs",
  };
  const writeMetadata = (payload: Record<string, unknown>) =>
    fs.writeFile(rollout, `${JSON.stringify({ type: "session_meta", payload })}\n`);
  await writeMetadata(metadata);
  const thread = idleThread({ id: metadata.id, source: "cli", path: rollout });
  const managedThreads = {
    has: vi.fn(async (_sourceHomeId: string, _threadId: string) => false),
    mark: vi.fn(async () => true),
    snapshot: vi.fn(async () => new Map()),
  };
  const factory = createCodexSessionCatalogControl({
    env: { CODEX_HOME: home },
    getPluginConfig: () => ({ appServer: { requestTimeoutMs } }),
    getRuntimeConfig: () => config,
    now,
    managedThreads,
  });
  const source = (await factory.homesForAgent("main"))[0]!;
  const control = factory.forRequest("main", source);
  pinnedConnectionMocks.request.mockImplementation(async ({ method }) =>
    method === "thread/read" ? { thread } : { data: [thread] },
  );
  return {
    home,
    root,
    rollout,
    metadata,
    writeMetadata,
    thread,
    managedThreads,
    factory,
    source,
    control,
  };
}

describe("Codex exact local eligibility", () => {
  it.each([{ custom: "atlas" }] as const)(
    "verifies interactive source %j using one selected rollout",
    async (source) => {
      const f = await localEligibilityFixture();
      f.thread.source = source;
      await f.writeMetadata({ ...f.metadata, source });
      await expect(f.control.requireEligibleThread(f.thread.id)).resolves.toBe(f.thread);
      expect(
        pinnedConnectionMocks.request.mock.calls.map(([r]) => [r.method, r.requestParams]),
      ).toEqual([["thread/read", { threadId: f.thread.id, includeTurns: false }]]);
      expect(commandRpcMocks.codexControlRequest).not.toHaveBeenCalled();
      expect(f.managedThreads.snapshot).not.toHaveBeenCalled();
    },
  );

  it.each([
    "noninteractive",
    "stale source",
    "wrong metadata",
    "wrong read",
    "outside",
    "symlink",
    "hardlink",
    "oversized",
    "managed",
    "managed provenance",
  ])("rejects %s evidence without broad listing", async (kind) => {
    const f = await localEligibilityFixture();
    const listed = { ...f.thread };
    if (kind === "noninteractive") {
      f.thread.source = "exec";
    } else if (kind === "stale source") {
      await f.writeMetadata({ ...f.metadata, source: "exec" });
    } else if (kind === "wrong metadata") {
      await f.writeMetadata({ ...f.metadata, id: "other-thread" });
    } else if (kind === "wrong read") {
      f.thread.id = "other-thread";
    } else if (kind === "outside") {
      f.thread.path = path.join(f.home, "source.jsonl");
      listed.path = f.thread.path;
      await fs.rename(f.rollout, f.thread.path);
    } else if (kind === "symlink" || kind === "hardlink") {
      const target = path.join(f.home, "source.jsonl");
      await fs.rename(f.rollout, target);
      if (kind === "symlink") {
        await fs.symlink(target, f.rollout);
      } else {
        await fs.link(target, f.rollout);
      }
    } else if (kind === "oversized") {
      await f.writeMetadata({ ...f.metadata, instructions: "x".repeat(1024 * 1024) });
    } else if (kind === "managed") {
      f.managedThreads.has.mockResolvedValue(true);
    } else {
      await f.writeMetadata({ ...f.metadata, originator: "openclaw" });
    }
    pinnedConnectionMocks.request.mockImplementation(async ({ method, requestParams }) => {
      if (method === "thread/read") {
        return { thread: f.thread };
      }
      if (method === "thread/list" && requestParams.useStateDbOnly === true) {
        return { data: [listed] };
      }
      throw new Error("broad listing must not run");
    });
    await expect(f.control.requireEligibleThread(f.metadata.id)).rejects.toThrow(
      "eligibility could not be verified",
    );
    expect(
      pinnedConnectionMocks.request.mock.calls.every(
        ([r]) => r.method !== "thread/list" || r.requestParams.useStateDbOnly === true,
      ),
    ).toBe(true);
  });

  it("rejects a resident archived thread without native listing or reading", async () => {
    const f = await localEligibilityFixture();
    commandRpcMocks.codexControlRequest.mockResolvedValue({ data: [f.thread] });
    await f.control.initialize();
    commandRpcMocks.codexControlRequest.mockResolvedValue({});
    await f.control.archiveThread(f.thread.id);
    commandRpcMocks.codexControlRequest.mockClear();
    await expect(f.control.requireEligibleThread(f.thread.id)).rejects.toThrow(
      "eligibility could not be verified",
    );
    expect(commandRpcMocks.codexControlRequest).not.toHaveBeenCalled();
    expect(pinnedConnectionMocks.request).not.toHaveBeenCalled();
  });

  it("keeps the eligibility deadline across exact reads and provenance verification", async () => {
    let now = 0;
    const f = await localEligibilityFixture(() => now, 1_000);
    pinnedConnectionMocks.request.mockImplementation(async () => {
      now += 1_001;
      return { thread: f.thread };
    });
    await expect(f.control.requireEligibleThread(f.thread.id)).rejects.toThrow(
      "eligibility could not be verified",
    );
    expect(pinnedConnectionMocks.request.mock.calls.map(([r]) => r.timeoutMs)).toEqual([1_000]);
    expect(commandRpcMocks.codexControlRequest).not.toHaveBeenCalled();
  });

  it("bounds stalled ownership lookup and prevents native reads after its deadline", async () => {
    const f = await localEligibilityFixture(() => Date.now(), 1_000);
    let release!: (managed: boolean) => void;
    f.managedThreads.has.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    vi.useFakeTimers();
    try {
      const result = expect(f.control.requireEligibleThread(f.thread.id)).rejects.toThrow(
        "eligibility could not be verified",
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await result;
      release(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(pinnedConnectionMocks.request).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["transcript", "node terminal"])(
    "uses exact eligibility for %s at the real catalog boundary",
    async (action) => {
      const f = await localEligibilityFixture();
      // Terminal viewing remains available while the source is active.
      if (action.includes("terminal")) {
        f.thread.status = { type: "active" };
      }
      const reply = ({
        method,
        requestParams,
      }: {
        method: string;
        requestParams: Record<string, unknown>;
      }) => {
        if (method === "thread/read") {
          return { thread: f.thread };
        }
        if (method === "thread/list" && requestParams.useStateDbOnly === true) {
          return { data: [f.thread] };
        }
        if (method === "thread/turns/list") {
          return { data: [] };
        }
        throw new Error("broad listing must not run");
      };
      pinnedConnectionMocks.request.mockImplementation(reply);
      commandRpcMocks.codexControlRequest.mockImplementation(
        async (_config, method, requestParams) => reply({ method, requestParams }),
      );
      const bindingStore = createCodexTestBindingStore();
      const { runtime } = createRuntime();
      const { api, getProvider } = createGatewayApi(runtime);
      const sources = { getPluginConfig: () => ({}), getRuntimeConfig: () => config };
      registerCodexSessionCatalog({ api, bindingStore, control: f.factory, ...sources });
      const provider = getProvider()!;
      const request = {
        hostId: f.source.hostId,
        sourceHomeId: f.source.sourceHomeId,
        threadId: f.thread.id,
      };
      const binary = path.join(f.home, process.platform === "win32" ? "codex.exe" : "codex");
      await fs.writeFile(binary, "synthetic executable; never launched", { mode: 0o755 });
      await withEnvAsync({ PATH: f.home }, async () => {
        if (action === "transcript") {
          await expect(provider.read(request)).resolves.toMatchObject({
            threadId: f.thread.id,
            items: [],
          });
        } else {
          const command = createCodexSessionCatalogNodeHostCommands(f.factory, bindingStore).find(
            (c) => c.command === CODEX_TERMINAL_RESUME_COMMAND,
          )!;
          const io = {
            signal: new AbortController().signal,
            emitChunk: async () => {},
            onInput: () => {},
          };
          await command.handle(
            JSON.stringify({
              agentId: "main",
              threadId: f.thread.id,
              cols: 80,
              rows: 24,
            }),
            io,
          );
          expect(nodeHostMocks.runNodePtyCommand).toHaveBeenCalledWith(
            expect.objectContaining({ args: ["resume", f.thread.id], cwd: f.thread.cwd }),
            io,
          );
        }
      });
      expect(pinnedConnectionMocks.request.mock.calls[0]?.[0]).toMatchObject({
        method: "thread/read",
        requestParams: { threadId: f.thread.id, includeTurns: false },
      });
      expect(
        pinnedConnectionMocks.request.mock.calls.filter(([r]) => r.method === "thread/read"),
      ).toHaveLength(1);
    },
  );

  it("does not promote cached negative provenance or cross-home ownership into eligibility", async () => {
    const f = await localEligibilityFixture();
    f.thread.originator = "codex_cli_rs";
    commandRpcMocks.codexControlRequest.mockResolvedValue({ data: [f.thread] });
    await f.control.initialize();
    await fs.rm(f.rollout);
    await expect(f.control.requireEligibleThread(f.thread.id)).rejects.toThrow(
      "eligibility could not be verified",
    );
    await f.writeMetadata(f.metadata);
    f.managedThreads.has.mockImplementation(
      async (sourceHomeId) => sourceHomeId !== f.source.sourceHomeId,
    );
    await expect(f.control.requireEligibleThread(f.thread.id)).resolves.toBe(f.thread);
    expect(f.managedThreads.has).toHaveBeenLastCalledWith(f.source.sourceHomeId, f.thread.id);
    const other = f.factory.forRequest("main", { ...f.source, sourceHomeId: "other-home" });
    await expect(other.requireEligibleThread(f.thread.id)).rejects.toThrow(
      "eligibility could not be verified",
    );
  });
});
