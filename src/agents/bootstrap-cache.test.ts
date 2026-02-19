import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  clearAllBootstrapSnapshots,
  clearBootstrapSnapshot,
  getBootstrapFileContent,
  getOrLoadBootstrapFiles,
  resolveBootstrapCacheKey,
} from "./bootstrap-cache.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

vi.mock("./workspace.js", () => ({
  loadWorkspaceBootstrapFiles: vi.fn(),
}));

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

function makeMissingFile(name: string): WorkspaceBootstrapFile {
  return { name: name as WorkspaceBootstrapFile["name"], path: `/ws/${name}`, missing: true };
}

describe("resolveBootstrapCacheKey", () => {
  it("prefers sessionKey over sessionId", () => {
    expect(resolveBootstrapCacheKey({ sessionKey: "sk", sessionId: "sid" })).toBe("sk");
  });

  it("falls back to sessionId when no sessionKey", () => {
    expect(resolveBootstrapCacheKey({ sessionId: "sid" })).toBe("sid");
  });

  it("returns undefined when neither provided", () => {
    expect(resolveBootstrapCacheKey({})).toBeUndefined();
  });
});

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

  it("bypasses cache when workspaceDir changes for same session key", async () => {
    const files2 = [makeFile("AGENTS.md", "# Agent other workspace")];
    mockLoad.mockResolvedValueOnce(files).mockResolvedValueOnce(files2);

    await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "session-1" });
    const result = await getOrLoadBootstrapFiles({ workspaceDir: "/ws2", sessionKey: "session-1" });

    expect(result).toBe(files2);
    expect(mockLoad).toHaveBeenCalledTimes(2);
  });

  it("loads without caching when no session key", async () => {
    await getOrLoadBootstrapFiles({ workspaceDir: "/ws" });
    await getOrLoadBootstrapFiles({ workspaceDir: "/ws" });

    expect(mockLoad).toHaveBeenCalledTimes(2);
  });

  it("uses sessionId as fallback cache key", async () => {
    await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionId: "sid-1" });
    const result = await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionId: "sid-1" });

    expect(result).toBe(files);
    expect(mockLoad).toHaveBeenCalledTimes(1);
  });
});

describe("getBootstrapFileContent", () => {
  const files = [
    makeFile("AGENTS.md", "# Agent rules"),
    makeFile("SOUL.md", "# Soul content"),
    makeMissingFile("MEMORY.md"),
  ];

  beforeEach(() => {
    clearAllBootstrapSnapshots();
    mockLoad.mockResolvedValue(files);
  });

  afterEach(() => {
    clearAllBootstrapSnapshots();
    vi.clearAllMocks();
  });

  it("returns content for a cached file", async () => {
    await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "sk" });
    expect(getBootstrapFileContent("sk", "AGENTS.md")).toBe("# Agent rules");
  });

  it("returns undefined for a missing file", async () => {
    await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "sk" });
    expect(getBootstrapFileContent("sk", "MEMORY.md")).toBeUndefined();
  });

  it("returns undefined when no cache entry exists", () => {
    expect(getBootstrapFileContent("no-such-key", "AGENTS.md")).toBeUndefined();
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

    // Next call should hit disk again
    await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "sk" });
    expect(mockLoad).toHaveBeenCalledTimes(2);
  });

  it("does not affect other sessions", async () => {
    await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "sk1" });
    await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "sk2" });

    clearBootstrapSnapshot("sk1");

    // sk2's cache entry survives clearing sk1 — third call hits cache, not disk
    await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "sk2" });
    expect(mockLoad).toHaveBeenCalledTimes(2); // sk1 initial load + sk2 initial load; sk2 re-read hit cache
  });
});

describe("TTL eviction", () => {
  beforeEach(() => {
    clearAllBootstrapSnapshots();
    vi.useFakeTimers();
    mockLoad.mockResolvedValue([makeFile("AGENTS.md", "content")]);
  });

  afterEach(() => {
    clearAllBootstrapSnapshots();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("serves cache within TTL", async () => {
    await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "sk" });
    vi.advanceTimersByTime(23 * 60 * 60 * 1000); // 23h — under TTL
    await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "sk" });
    expect(mockLoad).toHaveBeenCalledTimes(1);
  });

  it("evicts after TTL expires", async () => {
    await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "sk" });
    vi.advanceTimersByTime(25 * 60 * 60 * 1000); // 25h — over TTL

    // Need a second session key request to trigger sweep, then re-request sk
    await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "sk2" });
    await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "sk" });
    expect(mockLoad).toHaveBeenCalledTimes(3); // sk, sk2, sk again
  });
});
