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

  it("loads from disk on first call and seeds the session snapshot", async () => {
    const result = await getOrLoadBootstrapFiles({
      workspaceDir: "/ws",
      sessionKey: "session-1",
    });

    expect(result).toBe(files);
    expect(mockLoad()).toHaveBeenCalledTimes(1);
  });

  it("reuses the cached snapshot object when bootstrap content is unchanged", async () => {
    await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "session-1" });
    const result = await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "session-1" });

    expect(result).toBe(files);
    expect(mockLoad()).toHaveBeenCalledTimes(2);
  });

  it("refreshes the session snapshot when bootstrap content changes", async () => {
    const files2 = [makeFile("AGENTS.md", "# Agent v2")];
    mockLoad().mockResolvedValueOnce(files).mockResolvedValueOnce(files2);

    const r1 = await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "session-1" });
    const r2 = await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "session-1" });

    expect(r1).toBe(files);
    expect(r2).toBe(files2);
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
    const files2 = [makeFile("AGENTS.md", "content")];
    mockLoad()
      .mockResolvedValueOnce([makeFile("AGENTS.md", "content")])
      .mockResolvedValueOnce(files2);

    await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "sk" });
    clearBootstrapSnapshot("sk");

    // Next call should rebuild the session snapshot instead of reusing the cached object.
    const result = await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "sk" });
    expect(result).toBe(files2);
    expect(mockLoad()).toHaveBeenCalledTimes(2);
  });

  it("does not affect other sessions", async () => {
    const sk1Files = [makeFile("AGENTS.md", "content-1")];
    const sk2Files = [makeFile("AGENTS.md", "content-2")];
    const sk2FilesReload = [makeFile("AGENTS.md", "content-2")];
    mockLoad()
      .mockResolvedValueOnce(sk1Files)
      .mockResolvedValueOnce(sk2Files)
      .mockResolvedValueOnce(sk2FilesReload);

    await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "sk1" });
    await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "sk2" });

    clearBootstrapSnapshot("sk1");

    // sk2 should still retain its prior session snapshot because its content is unchanged.
    const result = await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "sk2" });
    expect(result).toBe(sk2Files);
    expect(mockLoad()).toHaveBeenCalledTimes(3);
  });
});
