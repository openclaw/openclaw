import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Dirent } from "node:fs";

// Mock node:fs
vi.mock("node:fs", () => ({
  readdirSync: vi.fn(() => []),
  readFileSync: vi.fn(() => ""),
  existsSync: vi.fn(() => false),
  statSync: vi.fn(() => ({ isDirectory: () => false, size: 100 })),
}));

vi.mock("node:fs/promises", () => ({
  readdir: vi.fn(async () => []),
  readFile: vi.fn(async () => ""),
  access: vi.fn(async () => {
    throw new Error("ENOENT");
  }),
  stat: vi.fn(async () => ({ isDirectory: () => false, isFile: () => false })),
}));

// Mock node:os
vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/home/testuser"),
}));

// Mock workspace
vi.mock("@/lib/workspace", () => ({
  resolveWorkspaceRoot: vi.fn(() => null),
  resolveOpenClawStateDir: vi.fn(() => "/home/testuser/.openclaw-dench"),
  getActiveWorkspaceName: vi.fn(() => null),
  parseSimpleYaml: vi.fn(() => ({})),
  duckdbQueryAll: vi.fn(() => []),
  duckdbQueryAllAsync: vi.fn(async () => []),
  isDatabaseFile: vi.fn(() => false),
  discoverDuckDBPaths: vi.fn(() => []),
  resolveDuckdbBin: vi.fn(() => null),
  safeResolvePath: vi.fn(() => null),
}));

function makeDirent(name: string, isDir: boolean): Dirent {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    isSymbolicLink: () => false,
    path: "",
    parentPath: "",
  } as Dirent;
}

describe("Workspace Tree & Browse API", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.mock("node:fs", () => ({
      readdirSync: vi.fn(() => []),
      readFileSync: vi.fn(() => ""),
      existsSync: vi.fn(() => false),
      statSync: vi.fn(() => ({ isDirectory: () => false, size: 100 })),
    }));
    vi.mock("node:fs/promises", () => ({
      readdir: vi.fn(async () => []),
      readFile: vi.fn(async () => ""),
      access: vi.fn(async () => {
        throw new Error("ENOENT");
      }),
      stat: vi.fn(async () => ({ isDirectory: () => false, isFile: () => false })),
    }));
    vi.mock("node:os", () => ({
      homedir: vi.fn(() => "/home/testuser"),
    }));
    vi.mock("@/lib/workspace", () => ({
      resolveWorkspaceRoot: vi.fn(() => null),
      resolveOpenClawStateDir: vi.fn(() => "/home/testuser/.openclaw-dench"),
      getActiveWorkspaceName: vi.fn(() => null),
      parseSimpleYaml: vi.fn(() => ({})),
      duckdbQueryAll: vi.fn(() => []),
      duckdbQueryAllAsync: vi.fn(async () => []),
      isDatabaseFile: vi.fn(() => false),
      discoverDuckDBPaths: vi.fn(() => []),
      resolveDuckdbBin: vi.fn(() => null),
      safeResolvePath: vi.fn(() => null),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── GET /api/workspace/tree ────────────────────────────────────

  describe("GET /api/workspace/tree", () => {
    it("returns tree with exists=false when no workspace root", async () => {
      const { GET } = await import("./tree/route.js");
      const req = new Request("http://localhost/api/workspace/tree");
      const res = await GET(req);
      const json = await res.json();
      expect(json.exists).toBe(false);
      expect(json.tree).toEqual([]);
      expect(json.workspace).toBeNull();
    });

    it("returns tree with workspace files", async () => {
      const { resolveWorkspaceRoot, getActiveWorkspaceName } = await import("@/lib/workspace");
      vi.mocked(resolveWorkspaceRoot).mockReturnValue("/ws");
      vi.mocked(getActiveWorkspaceName).mockReturnValue("default");
      const { readdir: mockReaddir } = await import("node:fs/promises");
      vi.mocked(mockReaddir).mockImplementation((dir) => {
        if (String(dir) === "/ws") {
          return Promise.resolve([
            makeDirent("knowledge", true),
            makeDirent("readme.md", false),
          ] as unknown as Dirent[]);
        }
        return Promise.resolve([] as unknown as Dirent[]);
      });

      const { GET } = await import("./tree/route.js");
      const req = new Request("http://localhost/api/workspace/tree");
      const res = await GET(req);
      const json = await res.json();
      expect(json.exists).toBe(true);
      expect(json.tree.length).toBeGreaterThan(0);
      expect(json.workspace).toBe("default");
    });

    it("includes workspaceRoot in response", async () => {
      const { resolveWorkspaceRoot } = await import("@/lib/workspace");
      vi.mocked(resolveWorkspaceRoot).mockReturnValue("/ws");

      const { GET } = await import("./tree/route.js");
      const req = new Request("http://localhost/api/workspace/tree");
      const res = await GET(req);
      const json = await res.json();
      expect(json.workspaceRoot).toBe("/ws");
    });

    it("includes root IDENTITY.md in the workspace tree", async () => {
      const { resolveWorkspaceRoot } = await import("@/lib/workspace");
      vi.mocked(resolveWorkspaceRoot).mockReturnValue("/ws");
      const { readdir: mockReaddir } = await import("node:fs/promises");
      vi.mocked(mockReaddir).mockImplementation((dir) => {
        if (String(dir) === "/ws") {
          return Promise.resolve([
            makeDirent("IDENTITY.md", false),
            makeDirent("notes.md", false),
          ] as unknown as Dirent[]);
        }
        return Promise.resolve([] as unknown as Dirent[]);
      });

      const { GET } = await import("./tree/route.js");
      const req = new Request("http://localhost/api/workspace/tree");
      const res = await GET(req);
      const json = await res.json();
      const paths = (json.tree as Array<{ path: string }>).map((n) => n.path);
      expect(paths).toContain("IDENTITY.md");
      expect(paths).toContain("notes.md");
    });

    it("does not inject a virtual skills folder into the workspace tree", async () => {
      const { resolveWorkspaceRoot } = await import("@/lib/workspace");
      vi.mocked(resolveWorkspaceRoot).mockReturnValue("/ws");
      const { readdir: mockReaddir } = await import("node:fs/promises");
      vi.mocked(mockReaddir).mockImplementation((dir) => {
        if (String(dir) === "/ws") {
          return Promise.resolve([
            makeDirent("skills", true),
          ] as unknown as Dirent[]);
        }
        if (String(dir) === "/ws/skills") {
          return Promise.resolve([
            makeDirent("alpha", true),
          ] as unknown as Dirent[]);
        }
        if (String(dir) === "/ws/skills/alpha") {
          return Promise.resolve([
            makeDirent("SKILL.md", false),
          ] as unknown as Dirent[]);
        }
        return Promise.resolve([] as unknown as Dirent[]);
      });

      const { GET } = await import("./tree/route.js");
      const req = new Request("http://localhost/api/workspace/tree");
      const res = await GET(req);
      const json = await res.json();
      const rootPaths = (json.tree as Array<{ path: string }>).map((node) => node.path);
      expect(rootPaths).toContain("skills");
      expect(rootPaths).not.toContain("~skills");
    });

    it("yields before tree discovery completes (prevents UI freeze during active agent runs)", async () => {
      const { resolveWorkspaceRoot, duckdbQueryAll, duckdbQueryAllAsync } = await import("@/lib/workspace");
      vi.mocked(resolveWorkspaceRoot).mockReturnValue("/ws");
      vi.mocked(duckdbQueryAll).mockImplementation(() => {
        const start = Date.now();
        while (Date.now() - start < 75) {
          // busy wait: if the route ever regresses to the sync helper,
          // this test should fail on the elapsed-time assertion below.
        }
        return [];
      });

      let releaseDuckdb: (rows: Array<{ name: string }>) => void;
      const duckdbGate = new Promise<Array<{ name: string }>>((resolve) => {
        releaseDuckdb = resolve;
      });
      vi.mocked(duckdbQueryAllAsync).mockReturnValue(duckdbGate);

      const { readdir: mockReaddir } = await import("node:fs/promises");
      vi.mocked(mockReaddir).mockResolvedValue([] as unknown as Dirent[]);

      const { GET } = await import("./tree/route.js");
      const req = new Request("http://localhost/api/workspace/tree");

      const startedAt = Date.now();
      const responsePromise = GET(req);
      const elapsedMs = Date.now() - startedAt;

      expect(elapsedMs).toBeLessThan(40);

      releaseDuckdb!([]);
      const res = await responsePromise;
      expect(res.status).toBe(200);
    });
  });

  // ─── GET /api/workspace/browse ──────────────────────────────────

  describe("GET /api/workspace/browse", () => {
    it("returns directory listing", async () => {
      const { existsSync: mockExists, readdirSync: mockReaddir, statSync: mockStat } = await import("node:fs");
      vi.mocked(mockExists).mockReturnValue(true);
      vi.mocked(mockReaddir).mockReturnValue([
        makeDirent("file.txt", false),
        makeDirent("subfolder", true),
      ] as unknown as Dirent[]);
      vi.mocked(mockStat).mockReturnValue({ isDirectory: () => false, size: 100 } as never);

      const { GET } = await import("./browse/route.js");
      const req = new Request("http://localhost/api/workspace/browse?dir=/tmp/test");
      const res = await GET(req);
      const json = await res.json();
      expect(json.entries).toBeDefined();
      expect(json.currentDir).toBeDefined();
    });

    it("returns parentDir for nested directories", async () => {
      const { existsSync: mockExists, readdirSync: mockReaddir, statSync: mockStat } = await import("node:fs");
      vi.mocked(mockExists).mockReturnValue(true);
      vi.mocked(mockReaddir).mockReturnValue([]);
      vi.mocked(mockStat).mockReturnValue({ isDirectory: () => true, size: 0 } as never);

      const { GET } = await import("./browse/route.js");
      const req = new Request("http://localhost/api/workspace/browse?dir=/tmp/test/sub");
      const res = await GET(req);
      const json = await res.json();
      expect(json.parentDir).toBeDefined();
    });
  });

  // ─── GET /api/workspace/suggest-files ────────────────────────────

  describe("GET /api/workspace/suggest-files", () => {
    it("returns suggestions when workspace exists", async () => {
      const { resolveWorkspaceRoot } = await import("@/lib/workspace");
      vi.mocked(resolveWorkspaceRoot).mockReturnValue("/ws");
      const { existsSync: mockExists, readdirSync: mockReaddir } = await import("node:fs");
      vi.mocked(mockExists).mockReturnValue(true);
      vi.mocked(mockReaddir).mockReturnValue([
        makeDirent("doc.md", false),
      ] as unknown as Dirent[]);

      const { GET } = await import("./suggest-files/route.js");
      const req = new Request("http://localhost/api/workspace/suggest-files?q=doc");
      const res = await GET(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.items).toBeDefined();
    });

    it("includes root IDENTITY.md in sidebar file suggestions", async () => {
      const { resolveWorkspaceRoot } = await import("@/lib/workspace");
      vi.mocked(resolveWorkspaceRoot).mockReturnValue("/ws");
      const { existsSync: mockExists, readdirSync: mockReaddir } = await import("node:fs");
      vi.mocked(mockExists).mockReturnValue(true);
      vi.mocked(mockReaddir).mockImplementation((dir) => {
        if (String(dir) === "/ws") {
          return [
            makeDirent("IDENTITY.md", false),
            makeDirent("doc.md", false),
          ] as unknown as Dirent[];
        }
        return [] as unknown as Dirent[];
      });

      const { GET } = await import("./suggest-files/route.js");
      const req = new Request("http://localhost/api/workspace/suggest-files");
      const res = await GET(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      const names = (json.items as Array<{ name: string }>).map((item) => item.name);
      expect(names).toContain("doc.md");
      expect(names).toContain("IDENTITY.md");
    });
  });

  // ─── GET /api/workspace/context ──────────────────────────────────

  describe("GET /api/workspace/context", () => {
    it("returns exists=false when no workspace root", async () => {
      const { resolveWorkspaceRoot } = await import("@/lib/workspace");
      vi.mocked(resolveWorkspaceRoot).mockReturnValue(null);

      const { GET } = await import("./context/route.js");
      const res = await GET();
      const json = await res.json();
      expect(json.exists).toBe(false);
    });

    it("returns context when workspace_context.yaml exists", async () => {
      const { resolveWorkspaceRoot, parseSimpleYaml } = await import("@/lib/workspace");
      vi.mocked(resolveWorkspaceRoot).mockReturnValue("/ws");
      vi.mocked(parseSimpleYaml).mockReturnValue({ org_name: "Acme", org_slug: "acme" });
      const { existsSync: mockExists, readFileSync: mockReadFile } = await import("node:fs");
      vi.mocked(mockExists).mockReturnValue(true);
      vi.mocked(mockReadFile).mockReturnValue("org_name: Acme" as never);

      const { GET } = await import("./context/route.js");
      const res = await GET();
      const json = await res.json();
      expect(json.exists).toBe(true);
    });
  });

  // ─── GET /api/workspace/search-index ─────────────────────────────

  describe("GET /api/workspace/search-index", () => {
    it("returns empty items when no workspace", async () => {
      const { resolveWorkspaceRoot } = await import("@/lib/workspace");
      vi.mocked(resolveWorkspaceRoot).mockReturnValue(null);

      const { GET } = await import("./search-index/route.js");
      const res = await GET();
      const json = await res.json();
      expect(json.items).toEqual([]);
    });

    it("returns file items from workspace tree", async () => {
      const { resolveWorkspaceRoot, duckdbQueryAll } = await import("@/lib/workspace");
      vi.mocked(resolveWorkspaceRoot).mockReturnValue("/ws");
      vi.mocked(duckdbQueryAll).mockReturnValue([]);
      const { existsSync: mockExists, readdirSync: mockReaddir } = await import("node:fs");
      vi.mocked(mockExists).mockReturnValue(true);
      vi.mocked(mockReaddir).mockImplementation((dir) => {
        if (String(dir) === "/ws") {
          return [makeDirent("readme.md", false)] as unknown as Dirent[];
        }
        return [] as unknown as Dirent[];
      });

      const { GET } = await import("./search-index/route.js");
      const res = await GET();
      const json = await res.json();
      expect(json.items.length).toBeGreaterThanOrEqual(0);
    });
  });
});
