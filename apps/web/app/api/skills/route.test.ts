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

    it("dedupes duplicate slugs from skills.sh search results", async () => {
      vi.mocked(global.fetch).mockResolvedValue(
        new Response(JSON.stringify({
          skills: [
            {
              id: "vercel/next.js/nextjs",
              skillId: "nextjs",
              name: "Next.js",
              installs: 120,
              source: "vercel/next.js",
            },
            {
              id: "acme/nextjs/nextjs",
              skillId: "nextjs",
              name: "Next.js",
              installs: 12,
              source: "acme/nextjs",
            },
            {
              id: "vercel/react/react",
              skillId: "react",
              name: "React",
              installs: 200,
              source: "vercel/react",
            },
          ],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const { GET } = await import("./browse/route.js");
      const response = await GET({
        nextUrl: new URL("http://localhost/api/skills/browse?q=nextjs"),
      } as never);
      const json = await response.json();

      expect(json.skills).toEqual([
        {
          slug: "nextjs",
          displayName: "Next.js",
          summary: "Nextjs skill by vercel",
          installs: 120,
          source: "vercel/next.js",
        },
        {
          slug: "react",
          displayName: "React",
          summary: "React skill by vercel",
          installs: 200,
          source: "vercel/react",
        },
      ]);
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
          summary: "Nextjs Seo Optimizer skill by kumbajirajkumar123",
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

    it("keeps store-installed skills visible when metadata parsing fails but the lock entry exists", async () => {
      const { existsSync, readFileSync, readdirSync } = await import("node:fs");

      vi.mocked(existsSync).mockImplementation((filePath) => {
        const file = String(filePath);
        return (
          file === "/tmp/workspace/skills"
          || file === "/tmp/workspace/skills/nextjs"
          || file === "/tmp/workspace/.skills/lock.json"
        );
      });

      vi.mocked(readdirSync).mockImplementation((dir) => {
        if (String(dir) === "/tmp/workspace/skills") {
          return [{
            isDirectory: () => true,
            name: "nextjs",
          }] as never;
        }
        return [] as never;
      });

      vi.mocked(readFileSync).mockImplementation((filePath) => {
        if (String(filePath) === "/tmp/workspace/.skills/lock.json") {
          return JSON.stringify({
            nextjs: {
              slug: "nextjs",
              source: "vercel/next.js",
              installedAt: "2026-04-02T00:00:00.000Z",
              installedFrom: "skills.sh",
            },
          }) as never;
        }
        throw new Error("Unreadable SKILL.md");
      });

      const { GET } = await import("./route.js");
      const response = await GET();
      const json = await response.json();

      expect(json.skills).toEqual([
        {
          name: "nextjs",
          slug: "nextjs",
          description: "Installed from vercel/next.js",
          source: "skills.sh",
          filePath: "/tmp/workspace/skills/nextjs/SKILL.md",
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
        const d = String(dir);
        if (d === "/tmp/skills-sh-extract-123") {
          return [{
            isDirectory: () => true,
            name: "nextjs-seo-optimizer-main",
          }] as never;
        }
        if (d === "/tmp/skills-sh-extract-123/nextjs-seo-optimizer-main/skills") {
          return [{
            isDirectory: () => true,
            name: "nextjs-seo-optimizer",
          }] as never;
        }
        return [] as never;
      });

      vi.mocked(existsSync).mockImplementation((filePath) => {
        const file = String(filePath);
        return (
          file === "/tmp/skills-sh-extract-123/nextjs-seo-optimizer-main/skills"
          || file === "/tmp/skills-sh-extract-123/nextjs-seo-optimizer-main/skills/nextjs-seo-optimizer/SKILL.md"
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
      expect(json.skill).toEqual({
        name: "nextjs-seo-optimizer",
        slug: "nextjs-seo-optimizer",
        description: "",
        emoji: undefined,
        source: "skills.sh",
        filePath: "/tmp/workspace/skills/nextjs-seo-optimizer/SKILL.md",
        protected: false,
      });
      expect(execFileSync).toHaveBeenCalledWith(
        "tar",
        [
          "-xzf",
          expect.stringContaining("skills-sh-"),
          "-C",
          "/tmp/skills-sh-extract-123",
        ],
        {
          stdio: "pipe",
          timeout: 15_000,
        },
      );
      expect(mkdirSync).toHaveBeenCalledWith("/tmp/workspace/skills", { recursive: true });
      expect(cpSync).toHaveBeenCalledWith(
        "/tmp/skills-sh-extract-123/nextjs-seo-optimizer-main/skills/nextjs-seo-optimizer",
        "/tmp/workspace/skills/nextjs-seo-optimizer",
        { recursive: true, force: true },
      );
      expect(writeFileSync).toHaveBeenCalledWith(
        "/tmp/workspace/.skills/lock.json",
        expect.stringContaining("\"installedFrom\": \"skills.sh\""),
      );
    });

    it("installs a root-level SKILL.md repo (single skill at repo root)", async () => {
      const { cpSync, existsSync, readFileSync, readdirSync } = await import("node:fs");

      vi.mocked(global.fetch).mockImplementation(async (input) => {
        const url = String(input);
        if (url === "https://api.github.com/repos/someone/my-skill") {
          return new Response(JSON.stringify({ default_branch: "main" }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (url === "https://codeload.github.com/someone/my-skill/tar.gz/refs/heads/main") {
          return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });

      vi.mocked(readdirSync).mockImplementation((dir) => {
        if (String(dir) === "/tmp/skills-sh-extract-123") {
          return [{ isDirectory: () => true, name: "my-skill-main" }] as never;
        }
        return [] as never;
      });

      vi.mocked(existsSync).mockImplementation((filePath) => {
        const file = String(filePath);
        return (
          file === "/tmp/skills-sh-extract-123/my-skill-main/SKILL.md"
          || file === "/tmp/workspace/skills/my-skill/SKILL.md"
          || file === "/tmp/workspace/.skills/lock.json"
        );
      });

      vi.mocked(readFileSync).mockReturnValue("{}" as never);

      const { POST } = await import("./install/route.js");
      const response = await POST(new Request("http://localhost/api/skills/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: "my-skill", source: "someone/my-skill" }),
      }));
      const json = await response.json();

      expect(response.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(cpSync).toHaveBeenCalledWith(
        "/tmp/skills-sh-extract-123/my-skill-main",
        "/tmp/workspace/skills/my-skill",
        { recursive: true, force: true },
      );
    });

    it("installs a skill from skills/ subdirectory when slug matches", async () => {
      const { cpSync, existsSync, readFileSync, readdirSync } = await import("node:fs");

      vi.mocked(global.fetch).mockImplementation(async (input) => {
        const url = String(input);
        if (url === "https://api.github.com/repos/acme/skill-pack") {
          return new Response(JSON.stringify({ default_branch: "main" }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (url === "https://codeload.github.com/acme/skill-pack/tar.gz/refs/heads/main") {
          return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });

      vi.mocked(readdirSync).mockImplementation((dir) => {
        const d = String(dir);
        if (d === "/tmp/skills-sh-extract-123") {
          return [{ isDirectory: () => true, name: "skill-pack-main" }] as never;
        }
        if (d === "/tmp/skills-sh-extract-123/skill-pack-main/skills") {
          return [
            { isDirectory: () => true, name: "nextjs" },
            { isDirectory: () => true, name: "react" },
          ] as never;
        }
        return [] as never;
      });

      vi.mocked(existsSync).mockImplementation((filePath) => {
        const file = String(filePath);
        return (
          file === "/tmp/skills-sh-extract-123/skill-pack-main/skills"
          || file === "/tmp/skills-sh-extract-123/skill-pack-main/skills/nextjs/SKILL.md"
          || file === "/tmp/skills-sh-extract-123/skill-pack-main/skills/react/SKILL.md"
          || file === "/tmp/workspace/skills/nextjs/SKILL.md"
          || file === "/tmp/workspace/.skills/lock.json"
        );
      });

      vi.mocked(readFileSync).mockReturnValue("{}" as never);

      const { POST } = await import("./install/route.js");
      const response = await POST(new Request("http://localhost/api/skills/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: "nextjs", source: "acme/skill-pack" }),
      }));
      const json = await response.json();

      expect(response.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(json.slug).toBe("nextjs");
      expect(cpSync).toHaveBeenCalledWith(
        "/tmp/skills-sh-extract-123/skill-pack-main/skills/nextjs",
        "/tmp/workspace/skills/nextjs",
        { recursive: true, force: true },
      );
    });

    it("installs from agent-style directory (e.g. .claude/skills/)", async () => {
      const { cpSync, existsSync, readFileSync, readdirSync } = await import("node:fs");

      vi.mocked(global.fetch).mockImplementation(async (input) => {
        const url = String(input);
        if (url === "https://api.github.com/repos/dev/agent-skills") {
          return new Response(JSON.stringify({ default_branch: "main" }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (url === "https://codeload.github.com/dev/agent-skills/tar.gz/refs/heads/main") {
          return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });

      vi.mocked(readdirSync).mockImplementation((dir) => {
        const d = String(dir);
        if (d === "/tmp/skills-sh-extract-123") {
          return [{ isDirectory: () => true, name: "agent-skills-main" }] as never;
        }
        if (d === "/tmp/skills-sh-extract-123/agent-skills-main/.claude/skills") {
          return [{ isDirectory: () => true, name: "debugging" }] as never;
        }
        return [] as never;
      });

      vi.mocked(existsSync).mockImplementation((filePath) => {
        const file = String(filePath);
        return (
          file === "/tmp/skills-sh-extract-123/agent-skills-main/.claude/skills"
          || file === "/tmp/skills-sh-extract-123/agent-skills-main/.claude/skills/debugging/SKILL.md"
          || file === "/tmp/workspace/skills/debugging/SKILL.md"
          || file === "/tmp/workspace/.skills/lock.json"
        );
      });

      vi.mocked(readFileSync).mockReturnValue("{}" as never);

      const { POST } = await import("./install/route.js");
      const response = await POST(new Request("http://localhost/api/skills/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: "debugging", source: "dev/agent-skills" }),
      }));
      const json = await response.json();

      expect(response.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(cpSync).toHaveBeenCalledWith(
        "/tmp/skills-sh-extract-123/agent-skills-main/.claude/skills/debugging",
        "/tmp/workspace/skills/debugging",
        { recursive: true, force: true },
      );
    });

    it("installs a single discovered skill even if folder name differs from slug", async () => {
      const { cpSync, existsSync, readFileSync, readdirSync } = await import("node:fs");

      vi.mocked(global.fetch).mockImplementation(async (input) => {
        const url = String(input);
        if (url === "https://api.github.com/repos/author/cool-skill") {
          return new Response(JSON.stringify({ default_branch: "main" }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (url === "https://codeload.github.com/author/cool-skill/tar.gz/refs/heads/main") {
          return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });

      vi.mocked(readdirSync).mockImplementation((dir) => {
        const d = String(dir);
        if (d === "/tmp/skills-sh-extract-123") {
          return [{ isDirectory: () => true, name: "cool-skill-main" }] as never;
        }
        if (d === "/tmp/skills-sh-extract-123/cool-skill-main/skills") {
          return [{ isDirectory: () => true, name: "actual-skill-name" }] as never;
        }
        return [] as never;
      });

      vi.mocked(existsSync).mockImplementation((filePath) => {
        const file = String(filePath);
        return (
          file === "/tmp/skills-sh-extract-123/cool-skill-main/skills"
          || file === "/tmp/skills-sh-extract-123/cool-skill-main/skills/actual-skill-name/SKILL.md"
          || file === "/tmp/workspace/skills/different-slug/SKILL.md"
          || file === "/tmp/workspace/.skills/lock.json"
        );
      });

      vi.mocked(readFileSync).mockReturnValue("{}" as never);

      const { POST } = await import("./install/route.js");
      const response = await POST(new Request("http://localhost/api/skills/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: "different-slug", source: "author/cool-skill" }),
      }));
      const json = await response.json();

      expect(response.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(cpSync).toHaveBeenCalledWith(
        "/tmp/skills-sh-extract-123/cool-skill-main/skills/actual-skill-name",
        "/tmp/workspace/skills/different-slug",
        { recursive: true, force: true },
      );
    });

    it("returns a clear error for multi-skill package with no slug match", async () => {
      const { existsSync, readFileSync, readdirSync } = await import("node:fs");

      vi.mocked(global.fetch).mockImplementation(async (input) => {
        const url = String(input);
        if (url === "https://api.github.com/repos/acme/multi-skills") {
          return new Response(JSON.stringify({ default_branch: "main" }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (url === "https://codeload.github.com/acme/multi-skills/tar.gz/refs/heads/main") {
          return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });

      vi.mocked(readdirSync).mockImplementation((dir) => {
        const d = String(dir);
        if (d === "/tmp/skills-sh-extract-123") {
          return [{ isDirectory: () => true, name: "multi-skills-main" }] as never;
        }
        if (d === "/tmp/skills-sh-extract-123/multi-skills-main/skills") {
          return [
            { isDirectory: () => true, name: "skill-a" },
            { isDirectory: () => true, name: "skill-b" },
          ] as never;
        }
        return [] as never;
      });

      vi.mocked(existsSync).mockImplementation((filePath) => {
        const file = String(filePath);
        return (
          file === "/tmp/skills-sh-extract-123/multi-skills-main/skills"
          || file === "/tmp/skills-sh-extract-123/multi-skills-main/skills/skill-a/SKILL.md"
          || file === "/tmp/skills-sh-extract-123/multi-skills-main/skills/skill-b/SKILL.md"
        );
      });

      vi.mocked(readFileSync).mockReturnValue("{}" as never);

      const { POST } = await import("./install/route.js");
      const response = await POST(new Request("http://localhost/api/skills/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: "nonexistent", source: "acme/multi-skills" }),
      }));
      const json = await response.json();

      expect(response.status).toBe(500);
      expect(json.ok).toBe(false);
      expect(json.error).toContain("multiple skills");
      expect(json.error).toContain("skill-a");
      expect(json.error).toContain("skill-b");
    });

    it("returns an error when no SKILL.md files exist in the repo", async () => {
      const { existsSync, readFileSync, readdirSync } = await import("node:fs");

      vi.mocked(global.fetch).mockImplementation(async (input) => {
        const url = String(input);
        if (url === "https://api.github.com/repos/empty/repo") {
          return new Response(JSON.stringify({ default_branch: "main" }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (url === "https://codeload.github.com/empty/repo/tar.gz/refs/heads/main") {
          return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });

      vi.mocked(readdirSync).mockImplementation((dir) => {
        if (String(dir) === "/tmp/skills-sh-extract-123") {
          return [{ isDirectory: () => true, name: "repo-main" }] as never;
        }
        return [] as never;
      });

      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(readFileSync).mockReturnValue("{}" as never);

      const { POST } = await import("./install/route.js");
      const response = await POST(new Request("http://localhost/api/skills/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: "anything", source: "empty/repo" }),
      }));
      const json = await response.json();

      expect(response.status).toBe(500);
      expect(json.ok).toBe(false);
      expect(json.error).toContain("does not contain any SKILL.md");
    });
  });
});
