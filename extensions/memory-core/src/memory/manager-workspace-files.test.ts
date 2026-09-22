import fs from "node:fs/promises";
import path from "node:path";
import { registerAgentWorkspaceAccess } from "openclaw/plugin-sdk/agent-workspace-runtime";
import {
  buildFileEntry,
  buildMultimodalChunkForIndexing,
  listMemoryFiles,
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
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("Gateway index over Harness workspace files", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
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
      async buildMultimodalChunk(entry) {
        const result = await buildMultimodalChunkForIndexing({
          ...entry,
          absPath: remote(entry.absPath),
        });
        return result
          ? { ...result, canonicalRelativePath: path.relative(gateway, entry.absPath) }
          : null;
      },
      async watch(_request, _onChange, signal) {
        if (!signal.aborted) {
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
      },
    };
    const rejectUnexpectedDocumentAccess = () => {
      throw new Error("Unexpected document bridge access");
    };
    release = registerAgentWorkspaceAccess(gateway, {
      memoryFiles: files,
      bridge: {
        readFile: rejectUnexpectedDocumentAccess,
        writeFile: rejectUnexpectedDocumentAccess,
        stat: rejectUnexpectedDocumentAccess,
      },
    });
    return { harness, files };
  }

  it.each(["active", "stopped"])(
    "keeps local Memory with a %s document-only bridge",
    async (state) => {
      await fs.writeFile(path.join(fixture.paths.workspace, "MEMORY.md"), "alpha local Memory.");
      release = registerAgentWorkspaceAccess(fixture.paths.workspace, {
        bridge: { readFile: vi.fn(), writeFile: vi.fn(), stat: vi.fn() },
      });
      if (state === "stopped") {
        release();
      }
      const cfg = fixture.createConfig({
        provider: "none",
        sources: ["memory"],
        vectorEnabled: false,
      });
      const manager = await fixture.getFreshManager(cfg, "cli");
      await manager.sync({ reason: "document-only", force: true });
      expect((await manager.search("alpha", { minScore: 0 }))[0]?.snippet).toContain(
        "local Memory",
      );
      expect((await manager.readFile({ relPath: "MEMORY.md" })).text).toContain("local Memory");
      expect(
        (await readAgentMemoryFile({ cfg, agentId: "main", relPath: "MEMORY.md" })).text,
      ).toContain("local Memory");
      expect(await listWorkspaceMemoryFiles(fixture.paths.workspace)).toContain(
        path.join(fixture.paths.workspace, "MEMORY.md"),
      );
      expect(
        await readWorkspaceText(
          fixture.paths.workspace,
          path.join(fixture.paths.workspace, "MEMORY.md"),
        ),
      ).toContain("local Memory");
    },
  );

  it("still rejects maintenance absent from an opted-in Memory host", async () => {
    await registerHarness();
    expect(() => getMemoryWorkspaceMaintenance(fixture.paths.workspace)).toThrow(
      "Remote Memory maintenance is unavailable",
    );
  });

  it("ranks remote extra paths by indexed host mtime despite absent or stale Gateway files", async () => {
    const { harness } = await registerHarness();
    await fs.mkdir(path.join(harness, "imports"));
    const old = path.join(harness, "imports/old.md");
    await fs.writeFile(old, "alpha imported knowledge.");
    await fs.writeFile(path.join(harness, "imports/new.md"), "alpha imported knowledge.");
    const oldTime = new Date(Date.now() - 90 * 86_400_000);
    await fs.utimes(old, oldTime, oldTime);
    const cfg = fixture.createConfig({
      provider: "none",
      sources: ["memory"],
      vectorEnabled: false,
      extraPaths: ["imports"],
    });
    // Native search applies a 30-day half-life; the Gateway has no copy of these files.
    const manager = await fixture.getFreshManager(cfg, "cli");
    await manager.sync({ reason: "remote-mtime", force: true });
    const before = await manager.search("alpha", { minScore: 0, maxResults: 10 });
    const oldScore = before.find((hit) => hit.path === "imports/old.md")?.score;
    const newScore = before.find((hit) => hit.path === "imports/new.md")?.score;
    if (oldScore === undefined || newScore === undefined) {
      throw new Error("Both host files must be indexed");
    }
    expect(oldScore).toBeLessThan(newScore / 4);
    await fs.mkdir(path.join(fixture.paths.workspace, "imports"));
    await fs.writeFile(path.join(fixture.paths.workspace, "imports/old.md"), "Gateway decoy.");
    const after = await manager.search("alpha", { minScore: 0, maxResults: 10 });
    expect(after.find((hit) => hit.path === "imports/old.md")?.score).toBeCloseTo(oldScore, 5);
  });

  it("indexes Harness bytes beside Gateway sessions and never indexes the local decoy", async () => {
    const { harness } = await registerHarness();
    await fs.writeFile(path.join(harness, "memory/notes.md"), "alpha Harness canonical notes.");
    await fs.writeFile(path.join(fixture.paths.memory, "notes.md"), "beta Gateway decoy notes.");
    await fixture.seedSessionTranscript({
      sessionId: "gateway-session",
      messages: [
        {
          role: "user",
          content: "alpha original Gateway conversation.",
          senderIsOwner: true,
          timestamp: Date.now(),
        },
      ],
    });
    const cfg = fixture.createConfig({
      provider: "none",
      sources: ["memory", "sessions"],
      sessionMemory: true,
      vectorEnabled: false,
    });
    const manager = await fixture.getFreshManager(cfg, "cli");
    await manager.sync({ reason: "split-storage", force: true });
    const results = await manager.search("alpha", { minScore: 0, maxResults: 20 });
    expect(
      results.some((hit) => hit.source === "memory" && hit.snippet.includes("Harness canonical")),
    ).toBe(true);
    expect(
      results.some(
        (hit) => hit.source === "sessions" && hit.snippet.includes("Gateway conversation"),
      ),
    ).toBe(true);
    expect(await manager.search("decoy", { minScore: 0 })).toEqual([]);
    expect((await manager.readFile({ relPath: "memory/notes.md" })).text).toContain(
      "Harness canonical",
    );
    expect(
      (await readAgentMemoryFile({ cfg, agentId: "main", relPath: "memory/notes.md" })).text,
    ).toContain("Harness canonical");
    expect(manager.status().dbPath).toContain(fixture.paths.stateDir);
    expect(await fs.readdir(harness)).toEqual(["memory"]);
    release?.();
    await expect(manager.readFile({ relPath: "memory/notes.md" })).rejects.toMatchObject({
      code: "WORKSPACE_ACCESS_UNAVAILABLE",
    });
  });

  it.each(["missing", "stopped"] as const)(
    "keeps session-only search on Gateway when Harness file access is %s",
    async (state) => {
      if (state === "missing") {
        release = registerAgentWorkspaceAccess(fixture.paths.workspace, {
          bridge: { readFile: vi.fn(), writeFile: vi.fn(), stat: vi.fn() },
        });
      } else {
        await registerHarness();
      }
      await fs.writeFile(path.join(fixture.paths.memory, "notes.md"), "Gateway decoy.");
      await fixture.seedSessionTranscript({
        sessionId: "gateway-only",
        messages: [
          {
            role: "user",
            content: "alpha Gateway session.",
            senderIsOwner: true,
            timestamp: Date.now(),
          },
        ],
      });
      const cfg = fixture.createConfig({
        provider: "none",
        sources: ["sessions"],
        sessionMemory: true,
        vectorEnabled: false,
      });
      const manager = await fixture.getFreshManager(cfg, "cli");
      await manager.sync({ reason: "session-only", force: true });
      if (state === "stopped") {
        release?.();
      }
      expect((await manager.search("alpha", { minScore: 0 }))[0]?.source).toBe("sessions");
      if (state === "stopped") {
        await expect(manager.readFile({ relPath: "memory/notes.md" })).rejects.toMatchObject({
          code: "WORKSPACE_ACCESS_UNAVAILABLE",
        });
      } else {
        expect((await manager.readFile({ relPath: "memory/notes.md" })).text).toContain(
          "Gateway decoy",
        );
      }
      expect((await getMemorySearchManager({ cfg, agentId: "main" })).manager).not.toBeNull();
    },
  );

  it("rechecks Harness content before publishing and does not adopt a Gateway decoy", async () => {
    const { harness, files } = await registerHarness();
    const note = path.join(harness, "memory/notes.md");
    await fs.writeFile(note, "alpha first remote version.");
    await fs.writeFile(path.join(fixture.paths.memory, "notes.md"), "alpha Gateway decoy.");
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
    const cfg = fixture.createConfig({
      provider: "none",
      sources: ["memory"],
      vectorEnabled: false,
    });
    const manager = await fixture.getFreshManager(cfg, "cli");
    await manager.sync({ reason: "changed-source", force: true });
    await manager.sync({ reason: "retry-current-source" });
    expect(await manager.search("alpha", { minScore: 0 })).toEqual([]);
    expect((await manager.search("beta", { minScore: 0 }))[0]?.snippet).toContain(
      "newer remote version",
    );
  });

  it("uses host change notifications and closes the subscription with the manager", async () => {
    const { harness, files } = await registerHarness();
    const note = path.join(harness, "memory/notes.md");
    await fs.writeFile(note, "alpha initial host note.");
    let changed: (() => void) | undefined;
    let watchSignal: AbortSignal | undefined;
    let watchRequest: Parameters<MemoryWorkspaceFiles["watch"]>[0] | undefined;
    files.watch = async (request, onChange, signal) => {
      watchRequest = request;
      changed = () => onChange("change");
      watchSignal = signal;
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    };
    const cfg = fixture.createConfig({
      provider: "none",
      sources: ["memory"],
      vectorEnabled: false,
    });
    const manager = await fixture.getPersistentManager(cfg);
    await manager.sync({ reason: "initial", force: true });
    expect(changed).toBeTypeOf("function");
    expect(Object.keys(watchRequest!.settings).toSorted()).toEqual([
      "extraPaths",
      "multimodal",
      "sync",
    ]);
    expect(Object.keys(watchRequest!.settings.sync)).toEqual(["watchDebounceMs"]);
    await fs.writeFile(note, "beta changed host note.");
    changed?.();
    await vi.waitFor(
      async () => {
        expect((await manager.search("beta", { minScore: 0 }))[0]?.snippet).toContain(
          "changed host note",
        );
      },
      { timeout: 15_000 },
    );
    await manager.close();
    expect(watchSignal?.aborted).toBe(true);
  });
});
