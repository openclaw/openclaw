import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/workspace", () => ({
  resolveWorkspaceRoot: vi.fn(() => "/tmp/workspace"),
  resolveOpenClawStateDir: vi.fn(() => "/tmp/state"),
}));

vi.mock("@/lib/ensure-composio-apps-skill", () => ({
  ensureComposioAppsSkillInWorkspaces: vi.fn(),
}));

vi.mock("node:fs", () => ({
  cpSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  mkdtempSync: vi.fn(() => "/tmp/skills-sh-extract-123"),
  readFileSync: vi.fn(() => ""),
  readdirSync: vi.fn(() => []),
  rmSync: vi.fn(),
  unlinkSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

describe("skills browse and install APIs", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  describe("GET /api/skills/browse", () => {
    it("passes through an explicit search query", async () => {
      vi.mocked(global.fetch).mockResolvedValue(
        new Response(JSON.stringify({ skills: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const { GET } = await import("./browse/route.js");
      await GET({
        nextUrl: new URL("http://localhost/api/skills/browse?q=nextjs&limit=2"),
      } as never);

      expect(global.fetch).toHaveBeenCalledWith(
        "https://skills.sh/api/search?q=nextjs&limit=2",
        expect.objectContaining({
          headers: { Accept: "application/json" },
        }),
      );
    });

    it("normalizes skills.sh payload and falls back to a featured query", async () => {
      vi.mocked(global.fetch).mockImplementation(async (input) => {
        const url = String(input);
        if (url === "https://skills.sh/api/search?q=nextjs&limit=50") {
          return new Response(JSON.stringify({
            skills: [
              {
                id: "kumbajirajkumar123/nextjs-seo-optimizer/nextjs-seo-optimizer",
                skillId: "nextjs-seo-optimizer",
                name: "nextjs-seo-optimizer",
                installs: 8,
                source: "kumbajirajkumar123/nextjs-seo-optimizer",
              },
            ],
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });

      const { GET } = await import("./browse/route.js");
      const response = await GET({
        nextUrl: new URL("http://localhost/api/skills/browse"),
      } as never);
      const json = await response.json();

      expect(global.fetch).toHaveBeenCalledWith(
        "https://skills.sh/api/search?q=nextjs&limit=50",
        expect.objectContaining({
          headers: { Accept: "application/json" },
        }),
      );
      expect(json.skills).toEqual([
        {
          slug: "nextjs-seo-optimizer",
          displayName: "nextjs-seo-optimizer",
          summary: "by kumbajirajkumar123/nextjs-seo-optimizer",
          installs: 8,
          source: "kumbajirajkumar123/nextjs-seo-optimizer",
        },
      ]);
    });
  });

  describe("GET /api/skills", () => {
    it("lists workspace skills from the installed skills directory", async () => {
      const { existsSync, readFileSync, readdirSync } = await import("node:fs");

      vi.mocked(existsSync).mockImplementation((filePath) => {
        const file = String(filePath);
        return (
          file === "/tmp/workspace/skills"
          || file === "/tmp/workspace/skills/nextjs-seo-optimizer/SKILL.md"
        );
      });

      vi.mocked(readdirSync).mockImplementation((dir) => {
        if (String(dir) === "/tmp/workspace/skills") {
          return [{
            isDirectory: () => true,
            name: "nextjs-seo-optimizer",
          }] as never;
        }
        return [] as never;
      });

      vi.mocked(readFileSync).mockReturnValue(
        [
          "---",
          "name: Next.js SEO Optimizer",
          "description: Optimize Next.js applications for search engines.",
          "emoji: \"🎯\"",
          "---",
          "# Next.js SEO Optimizer",
        ].join("\n") as never,
      );

      const { GET } = await import("./route.js");
      const response = await GET();
      const json = await response.json();

      expect(json.skills).toEqual([
        {
          name: "Next.js SEO Optimizer",
          slug: "nextjs-seo-optimizer",
          description: "Optimize Next.js applications for search engines.",
          emoji: "🎯",
          source: "workspace",
          filePath: "/tmp/workspace/skills/nextjs-seo-optimizer/SKILL.md",
          protected: false,
        },
      ]);
    });
  });

  describe("POST /api/skills/install", () => {
    it("installs a nested skill into workspace/skills and writes a skills lock entry", async () => {
      const {
        cpSync,
        existsSync,
        mkdirSync,
        readFileSync,
        readdirSync,
        writeFileSync,
      } = await import("node:fs");
      const { execFileSync } = await import("node:child_process");

      vi.mocked(global.fetch).mockImplementation(async (input) => {
        const url = String(input);
        if (url === "https://api.github.com/repos/kumbajirajkumar123/nextjs-seo-optimizer") {
          return new Response(JSON.stringify({ default_branch: "main" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url === "https://codeload.github.com/kumbajirajkumar123/nextjs-seo-optimizer/tar.gz/refs/heads/main") {
          return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });

      vi.mocked(readdirSync).mockImplementation((dir) => {
        if (String(dir) === "/tmp/skills-sh-extract-123") {
          return [{
            isDirectory: () => true,
            name: "nextjs-seo-optimizer-main",
          }] as never;
        }
        return [] as never;
      });

      vi.mocked(existsSync).mockImplementation((filePath) => {
        const file = String(filePath);
        return (
          file === "/tmp/skills-sh-extract-123/nextjs-seo-optimizer-main/nextjs-seo-optimizer/SKILL.md"
          || file === "/tmp/workspace/skills/nextjs-seo-optimizer/SKILL.md"
          || file === "/tmp/workspace/.skills/lock.json"
        );
      });

      vi.mocked(readFileSync).mockReturnValue("{}" as never);

      const { POST } = await import("./install/route.js");
      const response = await POST(new Request("http://localhost/api/skills/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: "nextjs-seo-optimizer",
          source: "kumbajirajkumar123/nextjs-seo-optimizer",
        }),
      }));
      const json = await response.json();

      expect(response.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(json.slug).toBe("nextjs-seo-optimizer");
      expect(execFileSync).toHaveBeenCalledWith(
        "tar",
        [
          "-xzf",
          expect.stringContaining("/tmp/skills-sh-"),
          "-C",
          "/tmp/skills-sh-extract-123",
        ],
        expect.objectContaining({ timeout: 15_000 }),
      );
      expect(mkdirSync).toHaveBeenCalledWith("/tmp/workspace/skills", { recursive: true });
      expect(cpSync).toHaveBeenCalledWith(
        "/tmp/skills-sh-extract-123/nextjs-seo-optimizer-main/nextjs-seo-optimizer",
        "/tmp/workspace/skills/nextjs-seo-optimizer",
        { recursive: true, force: true },
      );
      expect(writeFileSync).toHaveBeenCalledWith(
        "/tmp/workspace/.skills/lock.json",
        expect.stringContaining("\"installedFrom\": \"skills.sh\""),
      );
    });
  });
});
