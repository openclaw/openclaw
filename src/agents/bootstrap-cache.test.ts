import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, statSync: vi.fn() };
});

import { statSync } from "node:fs";
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
function setupStatSync(files: WorkspaceBootstrapFile[]): void {
  const mtimes = new Map<string, number>();
  for (const f of files) {
    mtimes.set(f.path, mtimeCounter++);
  }
  mockStatSync.mockImplementation((p: any) => {
    const ms = mtimes.get(String(p));
    if (ms === undefined) {
      throw new Error(`ENOENT: ${p}`);
    }
    return { mtimeMs: ms } as any;
  });
}

describe("getOrLoadBootstrapFiles", () => {
  const files = [makeFile("AGENTS.md", "# Agent"), makeFile("SOUL.md", "# Soul")];

  beforeEach(() => {
    clearAllBootstrapSnapshots();
    mockLoad.mockResolvedValue(files);
    setupStatSync(files);
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

    // Simulate mtime change on AGENTS.md
    mockStatSync.mockImplementation((p: any) => {
      if (String(p) === "/ws/AGENTS.md") {
        return { mtimeMs: Date.now() + 99999 } as any;
      }
      if (String(p) === "/ws/SOUL.md") {
        return { mtimeMs: 0 } as any;
      }
      throw new Error(`ENOENT: ${p}`);
    });

    const updatedFiles = [makeFile("AGENTS.md", "# Agent v2"), makeFile("SOUL.md", "# Soul")];
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
