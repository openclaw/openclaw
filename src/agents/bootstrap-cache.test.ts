import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAllBootstrapSnapshots,
  clearBootstrapSnapshot,
  getOrLoadBootstrapFiles,
} from "./bootstrap-cache.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

vi.mock("./workspace.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./workspace.js")>();
  return {
    ...actual,
    loadWorkspaceBootstrapFiles: vi.fn(),
  };
});

import { loadWorkspaceBootstrapFiles } from "./workspace.js";

const mockLoad = vi.mocked(loadWorkspaceBootstrapFiles);

function makeFile(name: string, content: string): WorkspaceBootstrapFile {
  return {
    name: name as WorkspaceBootstrapFile["name"],
    path: `/ws/${name}`,
    content,
    missing: false,
  };
}

describe("getOrLoadBootstrapFiles", () => {
  const files = [makeFile("AGENTS.md", "# Agent"), makeFile("SOUL.md", "# Soul")];

  beforeEach(() => {
    clearAllBootstrapSnapshots();
    mockLoad.mockResolvedValue(files);
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
});

describe("clearBootstrapSnapshot", () => {
  beforeEach(() => {
    clearAllBootstrapSnapshots();
    mockLoad.mockResolvedValue([makeFile("AGENTS.md", "content")]);
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

describe("mtime-based staleness detection", () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(() => {
    clearAllBootstrapSnapshots();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-cache-test-"));
    tmpFile = path.join(tmpDir, "USER.md");
    fs.writeFileSync(tmpFile, "# v1");
  });

  afterEach(() => {
    clearAllBootstrapSnapshots();
    vi.clearAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reloads when a cached file's mtime changes", async () => {
    const v1: WorkspaceBootstrapFile[] = [
      {
        name: "USER.md" as WorkspaceBootstrapFile["name"],
        path: tmpFile,
        content: "# v1",
        missing: false,
      },
    ];
    const v2: WorkspaceBootstrapFile[] = [
      {
        name: "USER.md" as WorkspaceBootstrapFile["name"],
        path: tmpFile,
        content: "# v2",
        missing: false,
      },
    ];
    mockLoad.mockResolvedValueOnce(v1).mockResolvedValueOnce(v2);

    // First load — caches v1
    const r1 = await getOrLoadBootstrapFiles({ workspaceDir: tmpDir, sessionKey: "s1" });
    expect(r1[0]?.content).toBe("# v1");
    expect(mockLoad).toHaveBeenCalledTimes(1);

    // Modify file on disk (bumps mtime)
    const futureTime = new Date(Date.now() + 2000);
    fs.writeFileSync(tmpFile, "# v2");
    fs.utimesSync(tmpFile, futureTime, futureTime);

    // Second load — stale mtime detected, reloads
    const r2 = await getOrLoadBootstrapFiles({ workspaceDir: tmpDir, sessionKey: "s1" });
    expect(r2[0]?.content).toBe("# v2");
    expect(mockLoad).toHaveBeenCalledTimes(2);
  });

  it("reloads when a cached file is deleted", async () => {
    const v1: WorkspaceBootstrapFile[] = [
      {
        name: "USER.md" as WorkspaceBootstrapFile["name"],
        path: tmpFile,
        content: "# v1",
        missing: false,
      },
    ];
    const v2: WorkspaceBootstrapFile[] = [
      { name: "USER.md" as WorkspaceBootstrapFile["name"], path: tmpFile, missing: true },
    ];
    mockLoad.mockResolvedValueOnce(v1).mockResolvedValueOnce(v2);

    await getOrLoadBootstrapFiles({ workspaceDir: tmpDir, sessionKey: "s1" });
    expect(mockLoad).toHaveBeenCalledTimes(1);

    // Delete the file
    fs.unlinkSync(tmpFile);

    // Should detect deletion and reload
    await getOrLoadBootstrapFiles({ workspaceDir: tmpDir, sessionKey: "s1" });
    expect(mockLoad).toHaveBeenCalledTimes(2);
  });

  it("does not reload when file is unchanged", async () => {
    const v1: WorkspaceBootstrapFile[] = [
      {
        name: "USER.md" as WorkspaceBootstrapFile["name"],
        path: tmpFile,
        content: "# v1",
        missing: false,
      },
    ];
    mockLoad.mockResolvedValue(v1);

    await getOrLoadBootstrapFiles({ workspaceDir: tmpDir, sessionKey: "s1" });
    await getOrLoadBootstrapFiles({ workspaceDir: tmpDir, sessionKey: "s1" });
    await getOrLoadBootstrapFiles({ workspaceDir: tmpDir, sessionKey: "s1" });

    // File unchanged — should only load once
    expect(mockLoad).toHaveBeenCalledTimes(1);
  });

  it("reloads when a previously missing file is created", async () => {
    const missingPath = path.join(tmpDir, "TOOLS.md");
    const v1: WorkspaceBootstrapFile[] = [
      { name: "TOOLS.md" as WorkspaceBootstrapFile["name"], path: missingPath, missing: true },
    ];
    const v2: WorkspaceBootstrapFile[] = [
      {
        name: "TOOLS.md" as WorkspaceBootstrapFile["name"],
        path: missingPath,
        content: "# Tools",
        missing: false,
      },
    ];
    mockLoad.mockResolvedValueOnce(v1).mockResolvedValueOnce(v2);

    // First load — file missing, cached as missing
    const r1 = await getOrLoadBootstrapFiles({ workspaceDir: tmpDir, sessionKey: "s1" });
    expect(r1[0]?.missing).toBe(true);
    expect(mockLoad).toHaveBeenCalledTimes(1);

    // Create the file on disk
    fs.writeFileSync(missingPath, "# Tools");

    // Second load — should detect creation and reload
    const r2 = await getOrLoadBootstrapFiles({ workspaceDir: tmpDir, sessionKey: "s1" });
    expect(r2[0]?.content).toBe("# Tools");
    expect(mockLoad).toHaveBeenCalledTimes(2);
  });

  it("reloads when MEMORY.md is created after initial cache (optional file)", async () => {
    const memoryPath = path.join(tmpDir, "MEMORY.md");
    // Initial load returns no memory file (it didn't exist)
    const v1: WorkspaceBootstrapFile[] = [
      {
        name: "USER.md" as WorkspaceBootstrapFile["name"],
        path: tmpFile,
        content: "# v1",
        missing: false,
      },
    ];
    const v2: WorkspaceBootstrapFile[] = [
      {
        name: "USER.md" as WorkspaceBootstrapFile["name"],
        path: tmpFile,
        content: "# v1",
        missing: false,
      },
      {
        name: "MEMORY.md" as WorkspaceBootstrapFile["name"],
        path: memoryPath,
        content: "# Memory",
        missing: false,
      },
    ];
    mockLoad.mockResolvedValueOnce(v1).mockResolvedValueOnce(v2);

    // First load — MEMORY.md absent, not in file list but watched via sentinel
    await getOrLoadBootstrapFiles({ workspaceDir: tmpDir, sessionKey: "s1" });
    expect(mockLoad).toHaveBeenCalledTimes(1);

    // Create MEMORY.md on disk
    fs.writeFileSync(memoryPath, "# Memory");

    // Second load — should detect creation of optional file and reload
    const r2 = await getOrLoadBootstrapFiles({ workspaceDir: tmpDir, sessionKey: "s1" });
    expect(r2).toHaveLength(2);
    expect(r2[1]?.content).toBe("# Memory");
    expect(mockLoad).toHaveBeenCalledTimes(2);
  });
});
