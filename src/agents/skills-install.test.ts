import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock loadWorkspaceSkillEntries
const mockLoadWorkspaceSkillEntries = vi.fn();
vi.mock("./skills.js", () => ({
  hasBinary: () => true,
  loadWorkspaceSkillEntries: (...args: unknown[]) => mockLoadWorkspaceSkillEntries(...args),
  resolveSkillsInstallPreferences: () => ({ nodeManager: "npm", preferBrew: false }),
}));

// Mock resolveSkillKey
vi.mock("./skills/frontmatter.js", () => ({
  resolveSkillKey: () => "test-skill",
}));

// Mock exec
vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" }),
}));

// Mock utils
vi.mock("../utils.js", async () => {
  const fs = await import("node:fs");
  return {
    CONFIG_DIR: "/tmp/test-config",
    ensureDir: async (dir: string) => {
      fs.mkdirSync(dir, { recursive: true });
    },
    resolveUserPath: (p: string) => p,
  };
});

// Mock brew
vi.mock("../infra/brew.js", () => ({
  resolveBrewExecutable: () => undefined,
}));

describe("installSkill trusted allowlist", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("blocks install when package is not in trusted allowlist", async () => {
    mockLoadWorkspaceSkillEntries.mockReturnValue([
      {
        skill: { name: "test-skill" },
        metadata: {
          install: [{ id: "node-0", kind: "node", package: "evil-package" }],
        },
      },
    ]);

    const { installSkill } = await import("./skills-install.js");
    const result = await installSkill({
      workspaceDir: "/tmp/workspace",
      skillName: "test-skill",
      installId: "node-0",
      config: {
        skills: {
          install: {
            trustedPackages: ["good-package", "another-safe-package"],
          },
        },
      } as never,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("not in trusted allowlist");
    expect(result.message).toContain("evil-package");
  });

  it("allows install when package is in trusted allowlist", async () => {
    mockLoadWorkspaceSkillEntries.mockReturnValue([
      {
        skill: { name: "test-skill" },
        metadata: {
          install: [{ id: "node-0", kind: "node", package: "good-package" }],
        },
      },
    ]);

    const { installSkill } = await import("./skills-install.js");
    const result = await installSkill({
      workspaceDir: "/tmp/workspace",
      skillName: "test-skill",
      installId: "node-0",
      config: {
        skills: {
          install: {
            trustedPackages: ["good-package"],
          },
        },
      } as never,
    });

    expect(result.ok).toBe(true);
  });

  it("allows install when trustedPackages is not configured", async () => {
    mockLoadWorkspaceSkillEntries.mockReturnValue([
      {
        skill: { name: "test-skill" },
        metadata: {
          install: [{ id: "node-0", kind: "node", package: "any-package" }],
        },
      },
    ]);

    const { installSkill } = await import("./skills-install.js");
    const result = await installSkill({
      workspaceDir: "/tmp/workspace",
      skillName: "test-skill",
      installId: "node-0",
      config: {} as never,
    });

    expect(result.ok).toBe(true);
  });
});

describe("installSkill download security", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects http:// download URLs", async () => {
    mockLoadWorkspaceSkillEntries.mockReturnValue([
      {
        skill: { name: "test-skill" },
        metadata: {
          install: [{ id: "dl-0", kind: "download", url: "http://evil.com/tool.tar.gz" }],
        },
      },
    ]);

    const { installSkill } = await import("./skills-install.js");
    const result = await installSkill({
      workspaceDir: "/tmp/workspace",
      skillName: "test-skill",
      installId: "dl-0",
      config: {} as never,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("https://");
  });

  it("rejects download when SHA-256 mismatches", async () => {
    // Mock global fetch to return a small body
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("hello"));
          controller.close();
        },
      }),
    }) as unknown as typeof fetch;

    mockLoadWorkspaceSkillEntries.mockReturnValue([
      {
        skill: { name: "test-skill" },
        metadata: {
          install: [
            {
              id: "dl-0",
              kind: "download",
              url: "https://example.com/tool.tar.gz",
              sha256: "0000000000000000000000000000000000000000000000000000000000000000",
              extract: false,
            },
          ],
        },
      },
    ]);

    const { installSkill } = await import("./skills-install.js");
    const result = await installSkill({
      workspaceDir: "/tmp/workspace",
      skillName: "test-skill",
      installId: "dl-0",
      config: {} as never,
    });

    globalThis.fetch = originalFetch;

    expect(result.ok).toBe(false);
    expect(result.message).toContain("SHA-256 mismatch");
  });

  it("rejects download exceeding size limit", async () => {
    // Mock global fetch to return a body larger than limit
    const bigChunk = new Uint8Array(1024);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          // Push ~2KB
          controller.enqueue(bigChunk);
          controller.enqueue(bigChunk);
          controller.close();
        },
      }),
    }) as unknown as typeof fetch;

    mockLoadWorkspaceSkillEntries.mockReturnValue([
      {
        skill: { name: "test-skill" },
        metadata: {
          install: [
            {
              id: "dl-0",
              kind: "download",
              url: "https://example.com/big-tool.tar.gz",
              extract: false,
            },
          ],
        },
      },
    ]);

    const { installSkill } = await import("./skills-install.js");
    const result = await installSkill({
      workspaceDir: "/tmp/workspace",
      skillName: "test-skill",
      installId: "dl-0",
      config: { skills: { maxDownloadSize: 512 } } as never,
    });

    globalThis.fetch = originalFetch;

    expect(result.ok).toBe(false);
    expect(result.message).toContain("size limit");
  });
});
