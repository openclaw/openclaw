import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceBootstrapFile } from "./workspace.js";

vi.mock("./workspace.js", () => ({
  loadWorkspaceBootstrapFiles: vi.fn(),
}));

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
  let clearAllBootstrapSnapshots: typeof import("./bootstrap-cache.js").clearAllBootstrapSnapshots;
  let getOrLoadBootstrapFiles: typeof import("./bootstrap-cache.js").getOrLoadBootstrapFiles;
  let workspaceModule: typeof import("./workspace.js");

  const mockLoad = () => vi.mocked(workspaceModule.loadWorkspaceBootstrapFiles);

  beforeAll(async () => {
    ({ clearAllBootstrapSnapshots, getOrLoadBootstrapFiles } =
      await import("./bootstrap-cache.js"));
    workspaceModule = await import("./workspace.js");
  });

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

    expect(result).toEqual(files);
    expect(mockLoad()).toHaveBeenCalledTimes(1);
  });

  it("returns cached result on second call", async () => {
    const firstResult = await getOrLoadBootstrapFiles({
      workspaceDir: "/ws",
      sessionKey: "session-1",
    });
    const result = await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "session-1" });

    expect(result).toBe(firstResult);
    expect(mockLoad()).toHaveBeenCalledTimes(1);
  });

  it("different session keys get independent caches", async () => {
    const files2 = [makeFile("AGENTS.md", "# Agent v2")];
    mockLoad().mockResolvedValueOnce(files).mockResolvedValueOnce(files2);

    const r1 = await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "session-1" });
    const r2 = await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "session-2" });

    expect(r1).toEqual(files);
    expect(r2).toEqual(files2);
    expect(mockLoad()).toHaveBeenCalledTimes(2);
  });

  it("deduplicates by path, keeping first occurrence", async () => {
    const filesWithDup = [
      makeFile("AGENTS.md", "# Agent v1"),
      makeFile("SOUL.md", "# Soul"),
      makeFile("AGENTS.md", "# Agent v2"), // duplicate path
    ];
    mockLoad().mockResolvedValueOnce(filesWithDup);

    const result = await getOrLoadBootstrapFiles({
      workspaceDir: "/ws",
      sessionKey: "session-dedup",
    });

    expect(result).toHaveLength(2);
    expect(result[0].content).toBe("# Agent v1"); // first occurrence kept
    expect(result[1].content).toBe("# Soul");
  });

  it("deduplicates case-insensitively (Windows paths)", async () => {
    const filesWithCaseDup: WorkspaceBootstrapFile[] = [
      {
        name: "AGENTS.md" as WorkspaceBootstrapFile["name"],
        path: "C:\\Users\\ws\\AGENTS.md",
        content: "first",
        missing: false,
      },
      {
        name: "AGENTS.md" as WorkspaceBootstrapFile["name"],
        path: "c:\\users\\ws\\agents.md",
        content: "second",
        missing: false,
      },
    ];
    mockLoad().mockResolvedValueOnce(filesWithCaseDup);

    const result = await getOrLoadBootstrapFiles({
      workspaceDir: "C:\\Users\\ws",
      sessionKey: "session-case",
    });

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("first");
  });

  it("deduplicates paths with mixed separators", async () => {
    const filesWithMixedSep: WorkspaceBootstrapFile[] = [
      {
        name: "AGENTS.md" as WorkspaceBootstrapFile["name"],
        path: "/ws/sub/../AGENTS.md",
        content: "first",
        missing: false,
      },
      {
        name: "AGENTS.md" as WorkspaceBootstrapFile["name"],
        path: "/ws/AGENTS.md",
        content: "second",
        missing: false,
      },
    ];
    mockLoad().mockResolvedValueOnce(filesWithMixedSep);

    const result = await getOrLoadBootstrapFiles({
      workspaceDir: "/ws",
      sessionKey: "session-sep",
    });

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("first");
  });

  it("handles empty files array", async () => {
    mockLoad().mockResolvedValueOnce([]);

    const result = await getOrLoadBootstrapFiles({
      workspaceDir: "/ws",
      sessionKey: "session-empty",
    });

    expect(result).toHaveLength(0);
  });
});

describe("clearBootstrapSnapshot", () => {
  let clearAllBootstrapSnapshots: typeof import("./bootstrap-cache.js").clearAllBootstrapSnapshots;
  let clearBootstrapSnapshot: typeof import("./bootstrap-cache.js").clearBootstrapSnapshot;
  let getOrLoadBootstrapFiles: typeof import("./bootstrap-cache.js").getOrLoadBootstrapFiles;
  let workspaceModule: typeof import("./workspace.js");

  const mockLoad = () => vi.mocked(workspaceModule.loadWorkspaceBootstrapFiles);

  beforeAll(async () => {
    ({ clearAllBootstrapSnapshots, clearBootstrapSnapshot, getOrLoadBootstrapFiles } =
      await import("./bootstrap-cache.js"));
    workspaceModule = await import("./workspace.js");
  });

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
    await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "sk2" });

    clearBootstrapSnapshot("sk1");

    // sk2 should still be cached.
    await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "sk2" });
    expect(mockLoad()).toHaveBeenCalledTimes(2); // sk1 x1, sk2 x1
  });
});
