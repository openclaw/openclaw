import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { constants, zstdCompressSync } from "node:zlib";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isOpenClawManagedCodexThread,
  readCodexSessionMeta,
} from "./session-catalog-provenance.js";
import {
  config,
  idleThread,
  commandRpcMocks,
  pinnedConnectionMocks,
  createCodexSessionCatalogControlFactory as createCodexSessionCatalogControl,
  createCatalogTestProvider,
  createCodexTestBindingStore,
  createCodexSessionCatalogNodeHostCommands,
  CODEX_TERMINAL_RESUME_COMMAND,
  nodeHostMocks,
  withEnvAsync,
} from "./session-catalog.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const meta = (id = "source", provider = "native-a") => ({
  type: "session_meta",
  payload: { id, model_provider: provider, dynamic_tools: [] },
});
const encode = (records: unknown[]) =>
  Buffer.from(records.map((record) => JSON.stringify(record)).join("\n") + "\n");
async function rolloutFixture(
  payload: Record<string, unknown> = meta().payload,
  compressed = false,
) {
  const home = await fs.realpath(tempDirs.make("codex-provenance-"));
  const root = path.join(home, "sessions");
  await fs.mkdir(root);
  const rollout = path.join(root, "source.jsonl");
  const selectedPath = compressed ? `${rollout}.zst` : rollout;
  const write = (bytes: Buffer) =>
    fs.writeFile(selectedPath, compressed ? zstdCompressSync(bytes) : bytes);
  const writeMetadata = (value: Record<string, unknown>) =>
    write(encode([{ type: "session_meta", payload: value }]));
  await writeMetadata(payload);
  return {
    home,
    root,
    rollout,
    selectedPath,
    write,
    writeMetadata,
    read: async () => {
      const result = await readCodexSessionMeta(root, rollout, "source", { canonicalSource: true });
      if (!result) {
        throw new Error("Rollout metadata could not be verified");
      }
      return result;
    },
  };
}

describe("bounded native rollout metadata", () => {
  it("keeps canonicalized catalog roots distinct from canonical source admission", async () => {
    const f = await rolloutFixture();
    const alias = `${f.root}.link`;
    await fs.symlink(f.root, alias);
    const rollout = path.join(alias, path.basename(f.rollout));
    await expect(readCodexSessionMeta(alias, rollout, "source")).resolves.toEqual(meta().payload);
    await expect(
      readCodexSessionMeta(alias, rollout, "source", { canonicalSource: true }),
    ).resolves.toBeUndefined();
  });

  it.each(["large history", "large decoder window"])(
    "keeps ordinary catalog metadata readable with %s",
    async (size) => {
      const f = await rolloutFixture(meta().payload, true);
      const history =
        size === "large history"
          ? randomBytes(9 * 1024 * 1024).toString("base64")
          : "x".repeat(33 * 1024 * 1024);
      await fs.writeFile(
        f.selectedPath,
        zstdCompressSync(encode([meta(), { type: "event_msg", payload: history }]), {
          params: { [constants.ZSTD_c_windowLog]: 26 },
        }),
      );
      await expect(readCodexSessionMeta(f.root, f.rollout, "source")).resolves.toEqual(
        meta().payload,
      );
      await expect(f.read()).rejects.toThrow();
    },
  );

  it("prefers the exact plain file", async () => {
    const f = await rolloutFixture(meta("source", "plain").payload);
    await fs.writeFile(
      `${f.rollout}.zst`,
      zstdCompressSync(encode([meta("source", "compressed")])),
    );
    expect((await f.read()).model_provider).toBe("plain");
  });

  it.each(["wrong identity", "incomplete header", "hardlink", "symlink", "outside root"])(
    "fails closed for %s without selecting a fallback",
    async (fault) => {
      const f = await rolloutFixture();
      await fs.writeFile(
        `${f.rollout}.zst`,
        zstdCompressSync(encode([meta("source", "fallback")])),
      );
      if (fault === "wrong identity") {
        await f.write(encode([meta("wrong")]));
      }
      if (fault === "incomplete header") {
        await f.write(Buffer.from('{"type":'));
      }
      if (fault === "hardlink") {
        await fs.link(f.rollout, `${f.rollout}.link`);
      }
      if (fault === "symlink") {
        await fs.rename(f.rollout, `${f.rollout}.real`);
        await fs.symlink(`${f.rollout}.real`, f.rollout);
      }
      if (fault === "outside root") {
        const child = path.join(f.root, "child");
        await fs.mkdir(child);
        await expect(readCodexSessionMeta(child, f.rollout, "source")).resolves.toBeUndefined();
      } else {
        await expect(f.read()).rejects.toThrow();
      }
    },
  );

  it("rejects invalid compressed header UTF-8 without contaminating the next read", async () => {
    const invalid = await rolloutFixture(meta().payload, true);
    await invalid.write(Buffer.from([0xff, 10]));
    await expect(invalid.read()).rejects.toThrow();
    const valid = await rolloutFixture(meta().payload, true);
    await expect(valid.read()).resolves.toEqual(meta().payload);
  });

  it.each(["input limit", "header limit"])("rejects compressed %s", async (fault) => {
    const f = await rolloutFixture(meta().payload, true);
    if (fault === "input limit") {
      await fs.appendFile(f.selectedPath, Buffer.alloc(8 * 1024 * 1024));
    } else {
      await f.write(encode([meta("source", "x".repeat(1024 * 1024))]));
    }
    await expect(f.read()).rejects.toThrow();
  });
});

describe("Codex catalog provenance", () => {
  it("does not seed rollout provenance cache from an API-only result", async () => {
    const { rollout: file } = await rolloutFixture({
      id: "uncached-originator",
      originator: "codex_cli_rs",
    });
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

  it("settles compressed read failures and preserves recovery without a plain fallback", async () => {
    const threadId = "compressed-read-failure-false";
    const { rollout: file, selectedPath: compressed } = await rolloutFixture(
      { id: threadId, originator: "openclaw", source: "vscode" },
      true,
    );
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
      await expect(isOpenClawManagedCodexThread(thread, path.dirname(file))).resolves.toBe(false);
    } finally {
      openSpy.mockRestore();
    }
    expect(failedHandle?.fd).toBe(-1);
    // An unreadable rollout supplies no durable negative provenance.
    await expect(isOpenClawManagedCodexThread(thread, path.dirname(file))).resolves.toBe(true);
  });
});

// Filesystem cases use the production budget; clock-driven cases select their own deadline.
async function localEligibilityFixture(now = () => 0, requestTimeoutMs?: number) {
  const metadata = {
    id: "12345678-1234-1234-1234-123456789abc",
    source: "cli",
    originator: "codex_cli_rs",
  };
  const rollout = await rolloutFixture(metadata);
  const thread = idleThread({ id: metadata.id, source: "cli", path: rollout.rollout });
  const managedThreads = {
    has: vi.fn(async (_sourceHomeId: string, _threadId: string) => false),
    mark: vi.fn(async () => true),
    snapshot: vi.fn(async () => new Map()),
  };
  const factory = createCodexSessionCatalogControl({
    env: { CODEX_HOME: rollout.home },
    getPluginConfig: () => ({ appServer: { requestTimeoutMs } }),
    getRuntimeConfig: () => config,
    now,
    managedThreads,
  });
  const source = (await factory.homesForAgent("main"))[0]!;
  const control = factory.forRequest("main", source);
  const reply = ({ method }: { method: string }, includeTurns = false) => {
    if (method === "thread/read") {
      return { thread };
    }
    if (includeTurns && method === "thread/turns/list") {
      return { data: [] };
    }
    throw new Error("broad listing must not run");
  };
  pinnedConnectionMocks.request.mockImplementation(async ({ method }) =>
    method === "thread/read" ? { thread } : { data: [thread] },
  );
  return {
    ...rollout,
    metadata,
    thread,
    managedThreads,
    factory,
    source,
    control,
    reply,
    reject: () =>
      expect(control.requireEligibleThread(metadata.id)).rejects.toThrow(
        "eligibility could not be verified",
      ),
  };
}

describe("Codex exact local eligibility", () => {
  it.each([
    "noninteractive",
    "stale source",
    "wrong read",
    "outside",
    "oversized",
    "managed",
    "managed provenance",
  ])("rejects %s evidence without broad listing", async (kind) => {
    const f = await localEligibilityFixture();
    if (kind === "noninteractive") {
      f.thread.source = "exec";
    } else if (kind === "stale source") {
      await f.writeMetadata({ ...f.metadata, source: "exec" });
    } else if (kind === "wrong read") {
      f.thread.id = "other-thread";
    } else if (kind === "outside") {
      f.thread.path = path.join(f.home, "source.jsonl");
      await fs.rename(f.rollout, f.thread.path);
    } else if (kind === "oversized") {
      await f.writeMetadata({ ...f.metadata, instructions: "x".repeat(1024 * 1024) });
    } else if (kind === "managed") {
      f.managedThreads.has.mockResolvedValue(true);
    } else {
      await f.writeMetadata({ ...f.metadata, originator: "openclaw" });
    }
    pinnedConnectionMocks.request.mockImplementation(async (request) => f.reply(request));
    await f.reject();
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
    await f.reject();
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
    await f.reject();
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
      const result = f.reject();
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
    "uses exact Atlas eligibility for %s at the real catalog boundary",
    async (action) => {
      const f = await localEligibilityFixture();
      f.thread.source = { custom: "atlas" };
      await f.writeMetadata({ ...f.metadata, source: f.thread.source });
      if (action === "node terminal") {
        f.thread.status = { type: "active" };
      }
      pinnedConnectionMocks.request.mockImplementation(async (request) => f.reply(request, true));
      commandRpcMocks.codexControlRequest.mockImplementation(async (_config, method) =>
        f.reply({ method }, true),
      );
      const bindingStore = createCodexTestBindingStore();
      const provider = createCatalogTestProvider({
        bindingStore,
        control: f.factory,
        getPluginConfig: () => ({}),
      });
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
      expect(f.managedThreads.snapshot).not.toHaveBeenCalled();
    },
  );

  it("does not promote cached negative provenance or cross-home ownership into eligibility", async () => {
    const f = await localEligibilityFixture();
    f.thread.originator = "codex_cli_rs";
    commandRpcMocks.codexControlRequest.mockResolvedValue({ data: [f.thread] });
    await f.control.initialize();
    await fs.rm(f.rollout);
    await f.reject();
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
