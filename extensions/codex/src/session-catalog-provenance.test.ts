import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexThread } from "./app-server/protocol.js";
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
  CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND,
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
  it.each(["openclaw", "codex_cli_rs", "OpenClaw", " openclaw ", " "])(
    "uses the exact native creation originator %j without reading the rollout",
    async (originator) => {
      const file = await writeRollout({ id: "native-provenance", originator: "openclaw" });
      const open = vi.spyOn(fs, "open");
      try {
        await expect(
          isOpenClawManagedCodexThread(
            idleThread({ id: "native-provenance", path: file, originator }),
            path.dirname(file),
          ),
        ).resolves.toBe(originator === "openclaw");
        expect(open).not.toHaveBeenCalled();
      } finally {
        open.mockRestore();
      }
    },
  );

  it.each([
    { label: "missing", originator: undefined },
    { label: "null", originator: null },
    { label: "empty", originator: "" },
    { label: "number", originator: 0 },
    { label: "boolean", originator: false },
    { label: "array", originator: [] },
    { label: "object", originator: {} },
  ])("keeps rollout fallback for native originator: $label", async ({ originator }) => {
    const file = await writeRollout({ id: "legacy-provenance", originator: "openclaw" });
    // Native JSON can violate the declared field type; the fallback owns that boundary.
    const thread = {
      ...idleThread({ id: "legacy-provenance", path: file }),
      originator,
    } as CodexThread;
    await expect(isOpenClawManagedCodexThread(thread, path.dirname(file))).resolves.toBe(true);
  });

  it("does not seed rollout provenance cache from an API-only result", async () => {
    const file = await writeRollout({ id: "uncached-originator", originator: "codex_cli_rs" });
    const thread = idleThread({ id: "uncached-originator", path: file, originator: "openclaw" });
    await expect(isOpenClawManagedCodexThread(thread, path.dirname(file))).resolves.toBe(true);
    await expect(
      isOpenClawManagedCodexThread({ ...thread, originator: null }, path.dirname(file)),
    ).resolves.toBe(false);
  });

  it("recognizes an OpenClaw-originated rollout even when Codex reports vscode", async () => {
    const file = await writeRollout({
      id: "managed-thread",
      originator: "openclaw",
      source: "vscode",
    });

    await expect(
      isOpenClawManagedCodexThread(
        { id: "managed-thread", path: file } as CodexThread,
        path.dirname(file),
      ),
    ).resolves.toBe(true);
  });

  it("does not inspect a rollout outside the selected local sessions root", async () => {
    const sessionsRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-codex-provenance-root-"),
    );
    temporaryDirectories.push(sessionsRoot);
    const file = await writeRollout({
      id: "outside-managed-thread",
      originator: "openclaw",
      source: "vscode",
    });
    await expect(
      isOpenClawManagedCodexThread(
        { id: "outside-managed-thread", path: file } as CodexThread,
        sessionsRoot,
      ),
    ).resolves.toBe(false);
    await expect(
      isOpenClawManagedCodexThread(
        { id: "outside-managed-thread", path: file, originator: "openclaw" } as CodexThread,
        undefined,
      ),
    ).resolves.toBe(false);
  });

  it("does not follow a rollout symlink outside the selected local sessions root", async () => {
    const sessionsRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-codex-provenance-root-"),
    );
    temporaryDirectories.push(sessionsRoot);
    const outside = await writeRollout({
      id: "symlinked-managed-thread",
      originator: "openclaw",
      source: "vscode",
    });
    const linked = path.join(sessionsRoot, "rollout.jsonl");
    await fs.symlink(outside, linked);

    await expect(
      isOpenClawManagedCodexThread(
        { id: "symlinked-managed-thread", path: linked } as CodexThread,
        sessionsRoot,
      ),
    ).resolves.toBe(false);
  });

  it("reads the complete session-meta line when embedded instructions exceed one chunk", async () => {
    const file = await writeRollout({
      id: "large-managed-thread",
      originator: "openclaw",
      base_instructions: { text: "x".repeat(80 * 1024) },
    });

    await expect(
      isOpenClawManagedCodexThread(
        { id: "large-managed-thread", path: file } as CodexThread,
        path.dirname(file),
      ),
    ).resolves.toBe(true);
  });

  it("reads a compressed rollout when Codex retains the missing plain path", async () => {
    const file = await writeRollout({
      id: "compressed-managed-thread",
      originator: "openclaw",
      source: "vscode",
    });
    const compressed = `${file}.zst`;
    await fs.writeFile(compressed, zstdCompressSync(await fs.readFile(file)));
    await fs.rm(file);

    await expect(
      isOpenClawManagedCodexThread(
        {
          id: "compressed-managed-thread",
          path: file,
        } as CodexThread,
        path.dirname(file),
      ),
    ).resolves.toBe(true);
  });

  it("preserves native and mismatched rollouts", async () => {
    const native = await writeRollout({
      id: "native-thread",
      originator: "codex_cli_rs",
      source: "cli",
    });
    const mismatched = await writeRollout({
      id: "different-thread",
      originator: "openclaw",
      source: "vscode",
    });

    await expect(
      isOpenClawManagedCodexThread(
        { id: "native-thread", path: native } as CodexThread,
        path.dirname(native),
      ),
    ).resolves.toBe(false);
    await expect(
      isOpenClawManagedCodexThread(
        { id: "requested-thread", path: mismatched } as CodexThread,
        path.dirname(mismatched),
      ),
    ).resolves.toBe(false);
    await expect(
      isOpenClawManagedCodexThread(
        { id: "missing-path", originator: "openclaw" } as CodexThread,
        path.dirname(native),
      ),
    ).resolves.toBe(false);
  });
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
  it("accepts a newly selected native rollout before resident discovery catches up", async () => {
    const f = await localEligibilityFixture();
    commandRpcMocks.codexControlRequest.mockResolvedValue({ data: [{ ...f.thread }] });
    await f.control.initialize();
    const replacement = path.join(f.root, "reverted.jsonl");
    await fs.copyFile(f.rollout, replacement);
    f.thread.path = replacement;
    f.thread.cwd = "/workspace/reverted";
    commandRpcMocks.codexControlRequest.mockClear();
    commandRpcMocks.codexControlRequest.mockRejectedValue(new Error("broad discovery unavailable"));

    await expect(f.control.requireEligibleThread(f.thread.id)).resolves.toMatchObject({
      path: replacement,
      cwd: "/workspace/reverted",
    });
    expect((await f.control.listPage({})).sessions[0]?.cwd).toBe("/workspace/reverted");
    expect(commandRpcMocks.codexControlRequest).not.toHaveBeenCalled();
    expect(pinnedConnectionMocks.request.mock.calls.map(([request]) => request.method)).toEqual([
      "thread/read",
    ]);
  });

  it.each(["cli", "vscode", { custom: "atlas" }, { custom: "chatgpt" }] as const)(
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
    "archived",
    "missing",
    "noninteractive",
    "stale source",
    "wrong metadata",
    "wrong read",
    "different rollout",
    "outside",
    "symlink",
    "hardlink",
    "malformed",
    "unreadable",
    "oversized",
    "managed",
    "managed provenance",
  ])("rejects %s evidence without broad listing", async (kind) => {
    const f = await localEligibilityFixture();
    const listed = { ...f.thread };
    if (kind === "archived") {
      const archived = path.join(f.home, "archived_sessions");
      await fs.mkdir(archived);
      await fs.rename(f.rollout, path.join(archived, "source.jsonl"));
      f.thread.path = path.join(archived, "source.jsonl");
      listed.path = f.thread.path;
    } else if (kind === "missing") {
      await fs.rm(f.rollout);
    } else if (kind === "noninteractive") {
      f.thread.source = "exec";
    } else if (kind === "stale source") {
      await f.writeMetadata({ ...f.metadata, source: "exec" });
    } else if (kind === "wrong metadata") {
      await f.writeMetadata({ ...f.metadata, id: "other-thread" });
    } else if (kind === "wrong read") {
      f.thread.id = "other-thread";
    } else if (kind === "different rollout") {
      commandRpcMocks.codexControlRequest.mockResolvedValue({ data: [listed] });
      await f.control.initialize();
      f.thread.path = path.join(f.root, "previous.jsonl");
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
    } else if (kind === "malformed") {
      await fs.writeFile(f.rollout, "not metadata\n");
    } else if (kind === "unreadable") {
      await fs.rm(f.rollout);
      await fs.mkdir(f.rollout);
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

  it.each([false, true])(
    "accepts native compressed path representation (read compressed: %s)",
    async (readCompressed) => {
      const f = await localEligibilityFixture();
      await fs.writeFile(`${f.rollout}.zst`, zstdCompressSync(await fs.readFile(f.rollout)));
      await fs.rm(f.rollout);
      f.thread.path = readCompressed ? `${f.rollout}.zst` : f.rollout;
      pinnedConnectionMocks.request.mockImplementation(async ({ method }) =>
        method === "thread/read"
          ? { thread: f.thread }
          : { data: [{ ...f.thread, path: readCompressed ? f.rollout : `${f.rollout}.zst` }] },
      );
      await expect(f.control.requireEligibleThread(f.thread.id)).resolves.toBe(f.thread);
    },
  );

  it("verifies a resident tail row with one exact read regardless of inventory size", async () => {
    const f = await localEligibilityFixture();
    commandRpcMocks.codexControlRequest.mockImplementation(async (_plugin, _method, params) =>
      params.cursor === "tail"
        ? { data: [f.thread] }
        : {
            data: Array.from({ length: 64 }, (_, i) => ({
              ...f.thread,
              id: `other-${i}`,
              originator: "codex_cli_rs",
              recencyAt: 42,
            })),
            nextCursor: "tail",
          },
    );
    await f.control.initialize();
    commandRpcMocks.codexControlRequest.mockClear();
    await expect(f.control.requireEligibleThread(f.thread.id)).resolves.toMatchObject({
      id: f.thread.id,
    });
    expect(commandRpcMocks.codexControlRequest).not.toHaveBeenCalled();
    expect(pinnedConnectionMocks.request.mock.calls.map(([r]) => r.method)).toEqual([
      "thread/read",
    ]);
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

  it.each(["transcript", "archive", "terminal", "node transcript", "node terminal"])(
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
        if (method === "thread/list" && requestParams.ancestorThreadId) {
          return { data: [] };
        }
        if (method === "thread/list" && requestParams.useStateDbOnly === true) {
          return { data: [f.thread] };
        }
        if (method === "thread/turns/list") {
          return { data: [] };
        }
        if (method === "thread/archive") {
          return {};
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
        } else if (action === "archive") {
          await expect(
            provider.archive!({ ...request, confirmNoOtherRunner: true }),
          ).resolves.toEqual({ ok: true });
        } else if (action === "terminal") {
          await expect(provider.openTerminal!(request)).resolves.toMatchObject({
            kind: "local",
            cwd: f.thread.cwd,
            argv: [binary, "resume", f.thread.id],
          });
        } else {
          const commandId =
            action === "node transcript"
              ? CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND
              : CODEX_TERMINAL_RESUME_COMMAND;
          const command = createCodexSessionCatalogNodeHostCommands(f.factory, bindingStore).find(
            (c) => c.command === commandId,
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
              ...(action === "node terminal" ? { cols: 80, rows: 24 } : {}),
            }),
            io,
          );
          if (action === "node terminal") {
            expect(nodeHostMocks.runNodePtyCommand).toHaveBeenCalledWith(
              expect.objectContaining({ args: ["resume", f.thread.id], cwd: f.thread.cwd }),
              io,
            );
          }
        }
      });
      expect(pinnedConnectionMocks.request.mock.calls[0]?.[0]).toMatchObject({
        method: "thread/read",
        requestParams: { threadId: f.thread.id, includeTurns: false },
      });
      expect(
        pinnedConnectionMocks.request.mock.calls.filter(([r]) => r.method === "thread/read"),
      ).toHaveLength(action === "archive" ? 2 : 1);
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

  it("uses fresh native membership and an exact read for a remote pathless source", async () => {
    const f = await localEligibilityFixture();
    const { localSessionsRoot: _root, ...remoteSource } = f.source;
    f.thread.path = null;
    commandRpcMocks.codexControlRequest.mockResolvedValue({ data: [f.thread] });
    const remote = f.factory.forRequest("main", remoteSource);
    await remote.initialize();
    commandRpcMocks.codexControlRequest.mockClear();
    await expect(remote.requireEligibleThread(f.thread.id)).resolves.toBe(f.thread);
    expect(commandRpcMocks.codexControlRequest).not.toHaveBeenCalled();
    expect(
      pinnedConnectionMocks.request.mock.calls.map(([r]) => [r.method, r.requestParams]),
    ).toEqual([
      ["thread/read", { threadId: f.thread.id, includeTurns: false }],
      [
        "thread/list",
        {
          archived: false,
          limit: 64,
          modelProviders: [],
          sortKey: "recency_at",
          sortDirection: "desc",
          cwd: f.thread.cwd,
        },
      ],
    ]);
  });
});
