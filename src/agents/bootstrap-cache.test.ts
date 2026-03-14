import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, statSync: vi.fn() };
});

import { type Stats, statSync } from "node:fs";
import {
  clearAllBootstrapSnapshots,
  clearBootstrapSnapshot,
  getOrLoadBootstrapFiles,
} from "./bootstrap-cache.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

vi.mock("./workspace.js", () => ({
  loadWorkspaceBootstrapFiles: vi.fn(),
}));

import { loadWorkspaceBootstrapFiles } from "./workspace.js";

const mockLoad = vi.mocked(loadWorkspaceBootstrapFiles);
const mockStatSync = vi.mocked(statSync);

let mtimeCounter = 1;

function makeFile(name: string, content: string): WorkspaceBootstrapFile {
  return {
    name: name as WorkspaceBootstrapFile["name"],
    path: `/ws/${name}`,
    content,
    missing: false,
  };
}

/** Make statSync return a stable mtimeMs for every known file path. */
function setupStatSync(files: WorkspaceBootstrapFile[]): Map<string, number> {
  const mtimes = new Map<string, number>();
  for (const f of files) {
    mtimes.set(f.path, mtimeCounter++);
  }
  mockStatSync.mockImplementation((p: unknown) => {
    const ms = mtimes.get(String(p));
    if (ms === undefined) {
      throw new Error(`ENOENT: ${String(p)}`);
    }
    return { mtimeMs: ms } as Stats;
  });
  return mtimes;
}

describe("getOrLoadBootstrapFiles", () => {
  const files = [makeFile("AGENTS.md", "# Agent"), makeFile("SOUL.md", "# Soul")];
  let originalMtimes: Map<string, number>;

  beforeEach(() => {
    clearAllBootstrapSnapshots();
    mockLoad.mockResolvedValue(files);
    originalMtimes = setupStatSync(files);
  });

  afterEach(() => {
    clearAllBootstrapSnapshots();
    vi.clearAllMocks();
  });

  it("loads from disk on first call and caches", async () => {
    const result = await getOrLoadBootstrapFiles({
      workspaceDir: "/ws",
      sessionKey: "session-1",
    });

    expect(result).toBe(files);
    expect(mockLoad).toHaveBeenCalledTimes(1);
  });

  it("returns cached result on second call", async () => {
    await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "session-1" });
    const result = await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "session-1" });

    expect(result).toBe(files);
    expect(mockLoad).toHaveBeenCalledTimes(1);
  });

  it("different session keys get independent caches", async () => {
    const files2 = [makeFile("AGENTS.md", "# Agent v2")];
    mockLoad.mockResolvedValueOnce(files).mockResolvedValueOnce(files2);

    const r1 = await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "session-1" });
    const r2 = await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "session-2" });

    expect(r1).toBe(files);
    expect(r2).toBe(files2);
    expect(mockLoad).toHaveBeenCalledTimes(2);
  });

  it("reloads when a file mtime changes (staleness check)", async () => {
    await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "session-1" });
    expect(mockLoad).toHaveBeenCalledTimes(1);

    // Simulate mtime change on AGENTS.md only
    mockStatSync.mockImplementation((p: unknown) => {
      if (String(p) === "/ws/AGENTS.md") {
        return { mtimeMs: Date.now() + 99999 } as Stats;
      }
      if (String(p) === "/ws/SOUL.md") {
        return { mtimeMs: originalMtimes.get("/ws/SOUL.md") } as Stats;
      }
      throw new Error(`ENOENT: ${String(p)}`);
    });

    const updatedFiles = [makeFile("AGENTS.md", "# Agent v2"), makeFile("SOUL.md", "# Soul")];
    mockLoad.mockResolvedValueOnce(updatedFiles);

    const result = await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "session-1" });
    expect(result).toBe(updatedFiles);
    expect(mockLoad).toHaveBeenCalledTimes(2);
  });

  it("reloads when a previously-missing file appears on disk", async () => {
    // Start with BOOTSTRAP.md missing from disk
    const bootstrapFile = makeFile("BOOTSTRAP.md", "");
    const filesWithMissing = [...files, bootstrapFile];
    mockLoad.mockResolvedValueOnce(filesWithMissing);

    // statSync throws for BOOTSTRAP.md (missing), succeeds for others
    mockStatSync.mockImplementation((p: unknown) => {
      const ms = originalMtimes.get(String(p));
      if (ms !== undefined) {
        return { mtimeMs: ms } as Stats;
      }
      throw new Error(`ENOENT: ${String(p)}`);
    });

    await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "session-1" });
    expect(mockLoad).toHaveBeenCalledTimes(1);

    // Now BOOTSTRAP.md appears on disk
    mockStatSync.mockImplementation((p: unknown) => {
      if (String(p) === "/ws/BOOTSTRAP.md") {
        return { mtimeMs: 999 } as Stats;
      }
      const ms = originalMtimes.get(String(p));
      if (ms !== undefined) {
        return { mtimeMs: ms } as Stats;
      }
      throw new Error(`ENOENT: ${String(p)}`);
    });

    const updatedFiles = [...files, { ...bootstrapFile, content: "# Bootstrap", missing: false }];
    mockLoad.mockResolvedValueOnce(updatedFiles);

    const result = await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "session-1" });
    expect(result).toBe(updatedFiles);
    expect(mockLoad).toHaveBeenCalledTimes(2);
  });
});

describe("clearBootstrapSnapshot", () => {
  const clearFiles = [makeFile("AGENTS.md", "content")];

  beforeEach(() => {
    clearAllBootstrapSnapshots();
    mockLoad.mockResolvedValue(clearFiles);
    setupStatSync(clearFiles);
  });

  afterEach(() => {
    clearAllBootstrapSnapshots();
    vi.clearAllMocks();
  });

  it("clears a single session entry", async () => {
    await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "sk" });
    clearBootstrapSnapshot("sk");

    // Next call should hit disk again.
    await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "sk" });
    expect(mockLoad).toHaveBeenCalledTimes(2);
  });

  it("does not affect other sessions", async () => {
    await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "sk1" });
    await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "sk2" });

    clearBootstrapSnapshot("sk1");

    // sk2 should still be cached.
    await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "sk2" });
    expect(mockLoad).toHaveBeenCalledTimes(2); // sk1 x1, sk2 x1
  });
});
