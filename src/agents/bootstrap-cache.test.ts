import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceBootstrapFile } from "./workspace.js";

vi.mock("./workspace.js", () => ({
  loadWorkspaceBootstrapFiles: vi.fn(),
}));

import {
  clearAllBootstrapSnapshots,
  clearBootstrapSnapshot,
  getBootstrapCacheSizeForTest,
  getOrLoadBootstrapFiles,
} from "./bootstrap-cache.js";
import { loadWorkspaceBootstrapFiles } from "./workspace.js";

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
  const mockLoad = () => vi.mocked(loadWorkspaceBootstrapFiles);

  beforeEach(() => {
    clearAllBootstrapSnapshots();
    mockLoad().mockResolvedValue(files);
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
    expect(mockLoad()).toHaveBeenCalledTimes(1);
  });

  it("refreshes from disk on second call while preserving unchanged object identity", async () => {
    const refreshedFiles = [makeFile("AGENTS.md", "# Agent"), makeFile("SOUL.md", "# Soul")];
    mockLoad().mockResolvedValueOnce(files).mockResolvedValueOnce(refreshedFiles);

    const first = await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "session-1" });
    const result = await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "session-1" });

    expect(first).toBe(files);
    expect(result).toBe(first);
    expect(result).not.toBe(refreshedFiles);
    expect(mockLoad()).toHaveBeenCalledTimes(2);
  });

  it("replaces cached result when workspace bootstrap contents change", async () => {
    const updatedFiles = [makeFile("AGENTS.md", "# Agent v2"), makeFile("SOUL.md", "# Soul")];
    mockLoad().mockResolvedValueOnce(files).mockResolvedValueOnce(updatedFiles);

    const first = await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "session-1" });
    const result = await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "session-1" });

    expect(first).toBe(files);
    expect(result).toBe(updatedFiles);
    expect(mockLoad()).toHaveBeenCalledTimes(2);
  });

  it("different session keys get independent caches", async () => {
    const files2 = [makeFile("AGENTS.md", "# Agent v2")];
    mockLoad().mockResolvedValueOnce(files).mockResolvedValueOnce(files2);

    const r1 = await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "session-1" });
    const r2 = await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "session-2" });

    expect(r1).toBe(files);
    expect(r2).toBe(files2);
    expect(mockLoad()).toHaveBeenCalledTimes(2);
  });
});

describe("clearBootstrapSnapshot", () => {
  const mockLoad = () => vi.mocked(loadWorkspaceBootstrapFiles);

  beforeEach(() => {
    clearAllBootstrapSnapshots();
    mockLoad().mockResolvedValue([makeFile("AGENTS.md", "content")]);
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
    expect(mockLoad()).toHaveBeenCalledTimes(2);
  });

  it("does not affect other sessions", async () => {
    await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "sk1" });
    const first = await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "sk2" });

    clearBootstrapSnapshot("sk1");

    // sk2 should still preserve its cached snapshot identity after refresh.
    const second = await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "sk2" });
    expect(second).toBe(first);
    expect(mockLoad()).toHaveBeenCalledTimes(3); // sk1 x1, sk2 x2
  });
});

describe("bootstrap cache size cap", () => {
  const mockLoad = () => vi.mocked(loadWorkspaceBootstrapFiles);

  beforeEach(() => {
    clearAllBootstrapSnapshots();
    mockLoad().mockResolvedValue([makeFile("AGENTS.md", "content")]);
  });

  afterEach(() => {
    clearAllBootstrapSnapshots();
    vi.clearAllMocks();
  });

  it("stays bounded at BOOTSTRAP_CACHE_MAX_SIZE under churn", async () => {
    // Insert 65 distinct session keys — one more than the cap (64).
    for (let i = 0; i < 65; i += 1) {
      await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: `session-${i}` });
    }

    expect(getBootstrapCacheSizeForTest()).toBe(64);
  });

  it("evicts the oldest key when the cap is reached", async () => {
    // Fill up to cap.
    for (let i = 0; i < 64; i += 1) {
      await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: `session-${i}` });
    }
    // session-0 is the oldest entry; adding session-64 should evict it.
    await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "session-64" });

    // session-0 was evicted — the next access must hit disk.
    mockLoad().mockClear();
    await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "session-0" });
    expect(mockLoad()).toHaveBeenCalledTimes(1);
  });

  it("refreshes access order so recently used keys survive eviction", async () => {
    // Fill to cap, then refresh session-0 (moves it to end of insertion order).
    for (let i = 0; i < 64; i += 1) {
      await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: `session-${i}` });
    }
    // Refresh session-0 to make it the most recently used.
    await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "session-0" });

    // Adding session-64 should evict session-1 (now the oldest), not session-0.
    await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "session-64" });

    mockLoad().mockClear();
    // session-0 should still be cached.
    await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "session-0" });
    expect(mockLoad()).toHaveBeenCalledTimes(1); // still loads because content refreshes per turn
    expect(getBootstrapCacheSizeForTest()).toBe(64);
  });
});
