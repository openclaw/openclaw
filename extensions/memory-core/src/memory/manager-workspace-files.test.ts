import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { registerAgentWorkspaceAccess } from "openclaw/plugin-sdk/agent-workspace-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  buildFileEntry,
  listMemoryFiles,
  MEMORY_INDEX_CHUNKS_TABLE,
  readMemoryFile,
  type MemoryWorkspaceFiles,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { readAgentMemoryFile } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getMemoryWorkspaceMaintenance,
  listWorkspaceMemoryFiles,
  readWorkspaceText,
} from "../memory-workspace-files.js";
import { runInMemoryTestBackgroundContext } from "./background-context.test-support.js";
import type { MemoryIndexDatabase } from "./manager-database-context.js";
import { createManagerIndexFixture } from "./manager-index.test-support.js";
import type { MemoryIndexManager } from "./manager.js";

const managers = await import("./index.js");

describe("Gateway index over Harness workspace files", () => {
  const fixture = createManagerIndexFixture(managers);
  const createConfig = (overrides: Parameters<typeof fixture.createConfig>[0] = {}) =>
    fixture.createConfig({
      provider: "none",
      sources: ["memory"],
      vectorEnabled: false,
      ...overrides,
    });
  const write = (root: string, file: string, text: string) =>
    fs.writeFile(path.join(root, file), text);
  const seedSession = (sessionId: string, content: string) =>
    fixture.seedSessionTranscript({
      sessionId,
      messages: [{ role: "user", content, senderIsOwner: true, timestamp: Date.now() }],
    });
  async function createIndexedManager(
    overrides: Parameters<typeof createConfig>[0] = {},
    persistent = false,
  ) {
    const cfg = createConfig(overrides);
    const manager = await (persistent
      ? fixture.getPersistentManager(cfg)
      : fixture.getFreshManager(cfg, "cli"));
    await manager.sync({ reason: "initial", force: true });
    return { cfg, manager };
  }
  const search = (manager: MemoryIndexManager, query: string, maxResults?: number) =>
    manager.search(query, { minScore: 0, ...(maxResults === undefined ? {} : { maxResults }) });
  async function expectFile(
    manager: MemoryIndexManager,
    cfg: ReturnType<typeof createConfig>,
    relPath: string,
    text: string,
  ) {
    expect((await manager.readFile({ relPath })).text).toContain(text);
    expect((await readAgentMemoryFile({ cfg, agentId: "main", relPath })).text).toContain(text);
  }
  let release: (() => void) | undefined;
  afterEach(() => {
    release?.();
    release = undefined;
  });

  async function registerHarness() {
    const gateway = fixture.paths.workspace;
    const harness = path.join(fixture.paths.root, "harness");
    await fs.mkdir(path.join(harness, "memory"), { recursive: true });
    const remote = (file: string) => path.join(harness, path.relative(gateway, file));
    const local = (file: string) => path.join(gateway, path.relative(harness, file));
    let changed: Parameters<MemoryWorkspaceFiles["watch"]>[1] | undefined;
    const unexpectedAccess = () => {
      throw new Error("Unexpected document or multimodal access");
    };
    const files: MemoryWorkspaceFiles = {
      assertCurrent() {},
      async listFiles(_workspace, extraPaths, multimodal, skipped) {
        return (await listMemoryFiles(harness, extraPaths, multimodal, skipped)).map(local);
      },
      async inspectFile(file, _workspace, multimodal) {
        const entry = await buildFileEntry(remote(file), harness, multimodal);
        return entry ? { ...entry, absPath: local(entry.absPath) } : null;
      },
      readFile: (params) => readMemoryFile({ ...params, workspaceDir: harness }),
      async readForIndexing(file) {
        return {
          content: await fs.readFile(remote(file), "utf8"),
          canonicalRelativePath: path.relative(harness, await fs.realpath(remote(file))),
        };
      },
      buildMultimodalChunk: unexpectedAccess,
      async watch(_request, onChange, signal) {
        changed = onChange;
        if (!signal.aborted) {
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
      },
    };
    release = registerAgentWorkspaceAccess(gateway, {
      memoryFiles: files,
      bridge: {
        readFile: unexpectedAccess,
        writeFile: unexpectedAccess,
        stat: unexpectedAccess,
      },
    });
    return {
      harness,
      files,
      changed: () => {
        if (!changed) {
          throw new Error("Memory watch is not subscribed");
        }
        changed("change");
      },
    };
  }

  it("still rejects maintenance absent from an opted-in Memory host", async () => {
    await registerHarness();
    expect(() => getMemoryWorkspaceMaintenance(fixture.paths.workspace)).toThrow(
      "Remote Memory maintenance is unavailable",
    );
  });

  it.each([true, false])(
    "keeps Gateway sessions separate from Harness files (index memory: %s)",
    async (indexMemory) => {
      const { harness } = await registerHarness();
      await write(harness, "memory/notes.md", "alpha Harness canonical notes.");
      await write(fixture.paths.memory, "notes.md", "beta Gateway decoy notes.");
      await seedSession("gateway-session", "alpha original Gateway conversation.");
      const { cfg, manager } = await createIndexedManager({
        sources: indexMemory ? ["memory", "sessions"] : ["sessions"],
        sessionMemory: true,
      });
      if (indexMemory) {
        const hits = (await search(manager, "alpha", 20)).map(({ source, snippet }) => [
          source,
          snippet,
        ]);
        expect(hits).toEqual(
          expect.arrayContaining([
            ["memory", expect.stringContaining("Harness canonical")],
            ["sessions", expect.stringContaining("Gateway conversation")],
          ]),
        );
        expect(await search(manager, "decoy")).toEqual([]);
        await expectFile(manager, cfg, "memory/notes.md", "Harness canonical");
        expect(manager.status().dbPath).toContain(fixture.paths.stateDir);
        expect(await fs.readdir(harness)).toEqual(["memory"]);
      }
      release?.();
      if (!indexMemory) {
        expect((await search(manager, "alpha"))[0]?.source).toBe("sessions");
      }
      await expect(manager.readFile({ relPath: "memory/notes.md" })).rejects.toMatchObject({
        code: "WORKSPACE_ACCESS_UNAVAILABLE",
      });
      if (!indexMemory) {
        const reopened = await managers.getMemorySearchManager({
          runInBackgroundContext: runInMemoryTestBackgroundContext,
          cfg,
          agentId: "main",
        });
        expect(reopened.manager).not.toBeNull();
      }
    },
  );

  it("drains host edits arriving during indexing into the next watch generation", async () => {
    const { harness, files, changed } = await registerHarness();
    await write(harness, "memory/first.md", "alpha first.");
    await write(harness, "memory/second.md", "alpha second.");
    const { manager } = await createIndexedManager({}, true);
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const read = files.readForIndexing;
    const inspections = vi.spyOn(files, "inspectFile");
    const reads = vi.spyOn(files, "readForIndexing").mockImplementationOnce(async (file) => {
      entered.resolve();
      await resume.promise;
      return read(file);
    });
    const sync = vi.spyOn(manager, "sync");
    await write(harness, "memory/first.md", "beta first updated.");
    changed();
    await entered.promise;
    try {
      expect(reads).toHaveBeenCalledExactlyOnceWith(path.join(fixture.paths.memory, "first.md"));
      expect(inspections.mock.calls.map(([file]) => file)).toContain(
        path.join(fixture.paths.memory, "second.md"),
      );
      await write(harness, "memory/second.md", "beta second updated.");
      changed();
    } finally {
      resume.resolve();
    }
    await Promise.all(sync.mock.results.map((result) => result.value));
    using index = new DatabaseSync(manager.status().dbPath!, { readOnly: true });
    // Search can synchronize a dirty index and hide a stranded watch generation.
    // Observe publication before any consumer can repair the missing update.
    expect(
      index
        .prepare(`SELECT path, text FROM ${MEMORY_INDEX_CHUNKS_TABLE} ORDER BY path, start_line`)
        .all(),
    ).toEqual([
      { path: "memory/first.md", text: "beta first updated." },
      { path: "memory/second.md", text: "beta second updated." },
    ]);
  });

  it.each(["newer-index", "discovery-error"] as const)(
    "bounds joined watch generations when an active pass ends with %s",
    async (outcome) => {
      const { harness, files, changed } = await registerHarness();
      await write(harness, "memory/first.md", "alpha first.");
      const { manager } = await createIndexedManager({}, true);
      if (outcome === "newer-index") {
        const database = Reflect.get(manager, "publishedDatabase") as MemoryIndexDatabase;
        const meta = database.facts.meta;
        if (!meta || meta.chunkingVersion === undefined) {
          throw new Error("Expected the published index chunking version");
        }
        await database.writeMetadata({ ...meta, chunkingVersion: meta.chunkingVersion + 1 });
      } else {
        vi.spyOn(files, "listFiles").mockRejectedValueOnce(new Error("discovery unavailable"));
      }
      const owner = manager as unknown as {
        runSync: (params?: Parameters<typeof manager.sync>[0]) => Promise<void>;
      };
      const original = owner.runSync.bind(owner);
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const run = vi.spyOn(owner, "runSync").mockImplementationOnce(async (params) => {
        entered.resolve();
        await resume.promise;
        return original(params);
      });
      const sync = vi.spyOn(manager, "sync");
      changed();
      await entered.promise;
      try {
        for (let i = 0; i < 64; i += 1) {
          changed();
        }
      } finally {
        resume.resolve();
      }
      const settled = await Promise.allSettled(sync.mock.results.map((result) => result.value));
      expect(manager.status().dirty).toBe(true);
      expect(run).toHaveBeenCalledTimes(outcome === "newer-index" ? 2 : 1);
      expect(
        settled.every(
          (result) => result.status === (outcome === "newer-index" ? "fulfilled" : "rejected"),
        ),
      ).toBe(true);
    },
  );

  it("uses host change notifications and closes the subscription with the manager", async () => {
    const { harness, files } = await registerHarness();
    const note = path.join(harness, "memory/notes.md");
    await fs.writeFile(note, "alpha initial host note.");
    let changed: (() => void) | undefined;
    let watchSignal: AbortSignal | undefined;
    let watchRequest: Parameters<MemoryWorkspaceFiles["watch"]>[0] | undefined;
    const cancellation = createDeferred<void>();
    const retired = createDeferred<void>();
    files.watch = async (request, onChange, signal) => {
      watchRequest = request;
      changed = () => onChange("change");
      watchSignal = signal;
      signal.addEventListener("abort", () => cancellation.resolve(), { once: true });
      await cancellation.promise;
      await retired.promise;
      // The node transport finishes cancellation with this exact signal reason.
      signal.throwIfAborted();
    };
    const manager = await fixture.getPersistentManager(createConfig());
    try {
      await manager.sync({ reason: "initial", force: true });
      expect(changed).toBeTypeOf("function");
      expect(Object.keys(watchRequest!.settings).toSorted()).toEqual([
        "extraPaths",
        "multimodal",
        "sync",
      ]);
      expect(Object.keys(watchRequest!.settings.sync)).toEqual(["watchDebounceMs"]);
      const sync = vi.spyOn(manager, "sync");
      await fs.writeFile(note, "beta changed host note.");
      changed?.();
      expect(sync).toHaveBeenCalledWith({ reason: "watch" });
      await sync.mock.results.at(-1)!.value;
      expect((await search(manager, "beta"))[0]?.snippet).toContain("changed host note");
      const closed = vi.fn();
      const closing = manager.close().then(closed);
      try {
        await cancellation.promise;
        expect(watchSignal?.aborted).toBe(true);
        await Promise.resolve();
        expect(closed).not.toHaveBeenCalled();
        changed?.();
      } finally {
        retired.resolve();
        await closing;
      }
      expect(closed).toHaveBeenCalledOnce();
    } finally {
      retired.resolve();
      await manager.close();
    }
  });
  it("keeps local Memory with a stopped document-only bridge", async () => {
    const workspace = fixture.paths.workspace;
    await write(workspace, "MEMORY.md", "alpha local Memory.");
    release = registerAgentWorkspaceAccess(fixture.paths.workspace, {
      bridge: { readFile: vi.fn(), writeFile: vi.fn(), stat: vi.fn() },
    });
    release();
    const { cfg, manager } = await createIndexedManager();
    expect((await search(manager, "alpha"))[0]?.snippet).toContain("local Memory");
    await expectFile(manager, cfg, "MEMORY.md", "local Memory");
    expect(await listWorkspaceMemoryFiles(workspace)).toContain(path.join(workspace, "MEMORY.md"));
    expect(await readWorkspaceText(workspace, path.join(workspace, "MEMORY.md"))).toContain(
      "local Memory",
    );
  });

  it("ranks remote extra paths by indexed host mtime despite absent or stale Gateway files", async () => {
    const { harness } = await registerHarness();
    await fs.mkdir(path.join(harness, "imports"));
    const old = path.join(harness, "imports/old.md");
    await fs.writeFile(old, "alpha imported knowledge.");
    await write(harness, "imports/new.md", "alpha imported knowledge.");
    const oldTime = new Date(Date.now() - 90 * 86_400_000);
    await fs.utimes(old, oldTime, oldTime);
    // Native search applies a 30-day half-life; the Gateway has no copy of these files.
    const { manager } = await createIndexedManager({ extraPaths: ["imports"] });
    const before = await search(manager, "alpha", 10);
    const oldScore = before.find((hit) => hit.path === "imports/old.md")?.score;
    const newScore = before.find((hit) => hit.path === "imports/new.md")?.score;
    if (oldScore === undefined || newScore === undefined) {
      throw new Error("Both host files must be indexed");
    }
    expect(oldScore).toBeLessThan(newScore / 4);
    await fs.mkdir(path.join(fixture.paths.workspace, "imports"));
    await write(fixture.paths.workspace, "imports/old.md", "Gateway decoy.");
    const after = await search(manager, "alpha", 10);
    expect(after.find((hit) => hit.path === "imports/old.md")?.score).toBeCloseTo(oldScore, 5);
  });

  it("rechecks Harness content before publishing and does not adopt a Gateway decoy", async () => {
    const { harness, files } = await registerHarness();
    const note = path.join(harness, "memory/notes.md");
    await fs.writeFile(note, "alpha first remote version.");
    await write(fixture.paths.memory, "notes.md", "alpha Gateway decoy.");
    const read = files.readForIndexing;
    let changed = false;
    files.readForIndexing = async (file) => {
      const result = await read(file);
      if (!changed) {
        changed = true;
        await fs.writeFile(note, "beta newer remote version.");
      }
      return result;
    };
    const { manager } = await createIndexedManager();
    await manager.sync({ reason: "retry-current-source" });
    expect(await search(manager, "alpha")).toEqual([]);
    expect((await search(manager, "beta"))[0]?.snippet).toContain("newer remote version");
  });
});
