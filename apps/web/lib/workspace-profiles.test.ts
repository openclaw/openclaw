import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Dirent } from "node:fs";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const existsSync = vi.fn(() => false);
  const readFileSync = vi.fn(() => "");
  const readdirSync = vi.fn(() => []);
  const writeFileSync = vi.fn();
  const mkdirSync = vi.fn();
  const renameSync = vi.fn();
  return {
    ...actual,
    existsSync,
    readFileSync,
    readdirSync,
    writeFileSync,
    mkdirSync,
    renameSync,
    default: {
      ...actual,
      existsSync,
      readFileSync,
      readdirSync,
      writeFileSync,
      mkdirSync,
      renameSync,
    },
  };
});

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => ""),
  exec: vi.fn(
    (
      _cmd: string,
      _opts: unknown,
      cb: (err: Error | null, result: { stdout: string }) => void,
    ) => {
      cb(null, { stdout: "" });
    },
  ),
}));

vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/home/testuser"),
}));

import { join } from "node:path";

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

describe("workspace profiles", () => {
  const originalEnv = { ...process.env };
  const DEFAULT_STATE_DIR = join("/home/testuser", ".openclaw");
  const stateDirForProfile = (profile: string | null) =>
    !profile || profile.toLowerCase() === "default"
      ? DEFAULT_STATE_DIR
      : join("/home/testuser", `.openclaw-${profile}`);
  const UI_STATE_PATH = join(DEFAULT_STATE_DIR, ".ironclaw-ui-state.json");

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    delete process.env.OPENCLAW_PROFILE;
    delete process.env.OPENCLAW_HOME;
    delete process.env.OPENCLAW_WORKSPACE;
    delete process.env.OPENCLAW_STATE_DIR;

    vi.mock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      const existsSync = vi.fn(() => false);
      const readFileSync = vi.fn(() => "");
      const readdirSync = vi.fn(() => []);
      const writeFileSync = vi.fn();
      const mkdirSync = vi.fn();
      const renameSync = vi.fn();
      return {
        ...actual,
        existsSync,
        readFileSync,
        readdirSync,
        writeFileSync,
        mkdirSync,
        renameSync,
        default: {
          ...actual,
          existsSync,
          readFileSync,
          readdirSync,
          writeFileSync,
          mkdirSync,
          renameSync,
        },
      };
    });
    vi.mock("node:child_process", () => ({
      execSync: vi.fn(() => ""),
      exec: vi.fn(
        (
          _cmd: string,
          _opts: unknown,
          cb: (err: Error | null, result: { stdout: string }) => void,
        ) => {
          cb(null, { stdout: "" });
        },
      ),
    }));
    vi.mock("node:os", () => ({
      homedir: vi.fn(() => "/home/testuser"),
    }));
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  async function importWorkspace() {
    const {
      existsSync: es,
      readFileSync: rfs,
      readdirSync: rds,
      writeFileSync: wfs,
      renameSync: rs,
    } = await import("node:fs");
    const mod = await import("./workspace.js");
    return {
      ...mod,
      mockExists: vi.mocked(es),
      mockReadFile: vi.mocked(rfs),
      mockReaddir: vi.mocked(rds),
      mockWriteFile: vi.mocked(wfs),
      mockRename: vi.mocked(rs),
    };
  }

  // ─── getEffectiveProfile ──────────────────────────────────────────

  describe("getEffectiveProfile", () => {
    it("returns env var when OPENCLAW_PROFILE is set", async () => {
      process.env.OPENCLAW_PROFILE = "work";
      const { getEffectiveProfile } = await importWorkspace();
      expect(getEffectiveProfile()).toBe("work");
    });

    it("returns null when nothing is set", async () => {
      const { getEffectiveProfile, mockReadFile } = await importWorkspace();
      mockReadFile.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      expect(getEffectiveProfile()).toBeNull();
    });

    it("returns persisted profile from state file", async () => {
      const { getEffectiveProfile, mockReadFile } = await importWorkspace();
      mockReadFile.mockReturnValue(
        JSON.stringify({ activeProfile: "personal" }) as never,
      );
      expect(getEffectiveProfile()).toBe("personal");
    });

    it("env var takes precedence over persisted file", async () => {
      process.env.OPENCLAW_PROFILE = "env-profile";
      const { getEffectiveProfile, mockReadFile } = await importWorkspace();
      mockReadFile.mockReturnValue(
        JSON.stringify({ activeProfile: "file-profile" }) as never,
      );
      expect(getEffectiveProfile()).toBe("env-profile");
    });

    it("in-memory override takes precedence over persisted file", async () => {
      const { getEffectiveProfile, setUIActiveProfile, mockReadFile } =
        await importWorkspace();
      mockReadFile.mockReturnValue(
        JSON.stringify({ activeProfile: "file-profile" }) as never,
      );
      setUIActiveProfile("memory-profile");
      expect(getEffectiveProfile()).toBe("memory-profile");
    });

    it("env var takes precedence over in-memory override", async () => {
      process.env.OPENCLAW_PROFILE = "env-wins";
      const { getEffectiveProfile, setUIActiveProfile } =
        await importWorkspace();
      setUIActiveProfile("memory-profile");
      expect(getEffectiveProfile()).toBe("env-wins");
    });

    it("trims whitespace from env var", async () => {
      process.env.OPENCLAW_PROFILE = "  padded  ";
      const { getEffectiveProfile } = await importWorkspace();
      expect(getEffectiveProfile()).toBe("padded");
    });

    it("trims whitespace from persisted profile", async () => {
      const { getEffectiveProfile, mockReadFile } = await importWorkspace();
      mockReadFile.mockReturnValue(
        JSON.stringify({ activeProfile: "  trimme  " }) as never,
      );
      expect(getEffectiveProfile()).toBe("trimme");
    });

    it("uses persisted profile in non-test runtime", async () => {
      process.env.NODE_ENV = "production";
      process.env.VITEST = "false";
      const { getEffectiveProfile, mockReadFile } = await importWorkspace();
      mockReadFile.mockReturnValue(
        JSON.stringify({ activeProfile: "personal" }) as never,
      );
      expect(getEffectiveProfile()).toBe("personal");
    });
  });

  // ─── setUIActiveProfile ──────────────────────────────────────────

  describe("setUIActiveProfile", () => {
    it("persists profile to state file", async () => {
      const { setUIActiveProfile, mockReadFile, mockWriteFile, mockExists } =
        await importWorkspace();
      mockReadFile.mockReturnValue(JSON.stringify({}) as never);
      mockExists.mockReturnValue(true);
      setUIActiveProfile("work");
      expect(mockWriteFile).toHaveBeenCalledWith(
        UI_STATE_PATH,
        expect.stringContaining('"activeProfile": "work"'),
      );
    });

    it("null clears the override", async () => {
      const { setUIActiveProfile, mockReadFile, mockWriteFile, mockExists } =
        await importWorkspace();
      mockReadFile.mockReturnValue(JSON.stringify({}) as never);
      mockExists.mockReturnValue(true);
      setUIActiveProfile(null);
      expect(mockWriteFile).toHaveBeenCalledWith(
        UI_STATE_PATH,
        expect.stringContaining('"activeProfile": null'),
      );
    });

    it("preserves existing state keys", async () => {
      const { setUIActiveProfile, mockReadFile, mockWriteFile, mockExists } =
        await importWorkspace();
      mockReadFile.mockReturnValue(
        JSON.stringify({
          workspaceRegistry: { other: "/path" },
        }) as never,
      );
      mockExists.mockReturnValue(true);
      setUIActiveProfile("new");
      const stateWrites = mockWriteFile.mock.calls.filter((c) =>
        (c[0] as string).includes(".ironclaw-ui-state.json"),
      );
      expect(stateWrites.length).toBeGreaterThan(0);
      const parsed = JSON.parse(stateWrites[stateWrites.length - 1][1] as string);
      expect(parsed.workspaceRegistry).toEqual({ other: "/path" });
      expect(parsed.activeProfile).toBe("new");
    });
  });

  // ─── clearUIActiveProfileCache ────────────────────────────────────

  describe("clearUIActiveProfileCache", () => {
    it("re-reads from file after clearing", async () => {
      const {
        getEffectiveProfile,
        setUIActiveProfile,
        clearUIActiveProfileCache,
        mockReadFile,
      } = await importWorkspace();

      mockReadFile.mockReturnValue(
        JSON.stringify({ activeProfile: "from-file" }) as never,
      );
      setUIActiveProfile("in-memory");
      expect(getEffectiveProfile()).toBe("in-memory");

      clearUIActiveProfileCache();
      expect(getEffectiveProfile()).toBe("from-file");
    });
  });

  // ─── discoverProfiles ─────────────────────────────────────────────

  describe("discoverProfiles", () => {
    it("always includes default profile", async () => {
      const { discoverProfiles, mockExists } = await importWorkspace();
      mockExists.mockReturnValue(false);
      const profiles = discoverProfiles();
      expect(profiles).toHaveLength(1);
      expect(profiles[0].name).toBe("default");
    });

    it("default profile is active when no profile set", async () => {
      const { discoverProfiles, clearUIActiveProfileCache, mockExists, mockReadFile } =
        await importWorkspace();
      mockReadFile.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      mockExists.mockReturnValue(false);
      clearUIActiveProfileCache();
      const profiles = discoverProfiles();
      expect(profiles[0].isActive).toBe(true);
    });

    it("discovers profile-scoped .openclaw-<name> state directories", async () => {
      const { discoverProfiles, mockExists, mockReaddir } =
        await importWorkspace();
      const workStateDir = stateDirForProfile("work");
      const personalStateDir = stateDirForProfile("personal");
      mockExists.mockImplementation((p) => {
        const s = String(p);
        return (
          s === DEFAULT_STATE_DIR ||
          s === join(DEFAULT_STATE_DIR, "openclaw.json") ||
          s === join(workStateDir, "workspace") ||
          s === join(personalStateDir, "workspace")
        );
      });
      mockReaddir.mockReturnValue([
        makeDirent(".openclaw-work", true),
        makeDirent(".openclaw-personal", true),
        makeDirent("sessions", true),
        makeDirent("config.json", false),
      ] as unknown as Dirent[]);

      const profiles = discoverProfiles();
      const names = profiles.map((p) => p.name);
      expect(names).toContain("default");
      expect(names).toContain("work");
      expect(names).toContain("personal");
      expect(names).not.toContain("sessions");
    });

    it("marks active profile correctly", async () => {
      const { discoverProfiles, setUIActiveProfile, mockExists, mockReaddir } =
        await importWorkspace();
      const workStateDir = stateDirForProfile("work");
      mockExists.mockImplementation((p) => {
        const s = String(p);
        return (
          s === DEFAULT_STATE_DIR ||
          s === join(DEFAULT_STATE_DIR, "openclaw.json") ||
          s === join(workStateDir, "workspace")
        );
      });
      mockReaddir.mockReturnValue([
        makeDirent(".openclaw-work", true),
      ] as unknown as Dirent[]);

      setUIActiveProfile("work");
      const profiles = discoverProfiles();
      const defaultProfile = profiles.find((p) => p.name === "default");
      const workProfile = profiles.find((p) => p.name === "work");
      expect(defaultProfile?.isActive).toBe(false);
      expect(workProfile?.isActive).toBe(true);
    });

    it("merges registry entries for custom-path workspaces", async () => {
      const { discoverProfiles, mockExists, mockReadFile } =
        await importWorkspace();
      mockExists.mockImplementation((p) => {
        const s = String(p);
        return s === "/custom/workspace" || s === DEFAULT_STATE_DIR;
      });
      mockReadFile.mockReturnValue(
        JSON.stringify({
          workspaceRegistry: { custom: "/custom/workspace" },
        }) as never,
      );

      const profiles = discoverProfiles();
      const custom = profiles.find((p) => p.name === "custom");
      expect(custom).toBeDefined();
      expect(custom!.workspaceDir).toBe("/custom/workspace");
    });

    it("does not duplicate profiles seen via directory and registry", async () => {
      const { discoverProfiles, mockExists, mockReaddir, mockReadFile } =
        await importWorkspace();
      const stateDir = stateDirForProfile("shared");
      const wsDir = join(stateDir, "workspace");
      mockExists.mockImplementation((p) => {
        const s = String(p);
        return s === DEFAULT_STATE_DIR || s === wsDir;
      });
      mockReaddir.mockReturnValue([
        makeDirent(".openclaw-shared", true),
      ] as unknown as Dirent[]);
      mockReadFile.mockReturnValue(
        JSON.stringify({
          workspaceRegistry: { shared: wsDir },
        }) as never,
      );

      const profiles = discoverProfiles();
      const sharedProfiles = profiles.filter((p) => p.name === "shared");
      expect(sharedProfiles).toHaveLength(1);
    });

    it("handles unreadable state directory gracefully", async () => {
      const { discoverProfiles, mockExists, mockReaddir } =
        await importWorkspace();
      mockExists.mockReturnValue(true);
      mockReaddir.mockImplementation(() => {
        throw new Error("EACCES");
      });
      const profiles = discoverProfiles();
      expect(profiles.length).toBeGreaterThanOrEqual(1);
      expect(profiles[0].name).toBe("default");
    });
  });

  // ─── resolveWebChatDir ────────────────────────────────────────────

  describe("resolveWebChatDir", () => {
    it("returns web-chat for default profile", async () => {
      const { resolveWebChatDir, mockReadFile } = await importWorkspace();
      mockReadFile.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      expect(resolveWebChatDir()).toBe(join(DEFAULT_STATE_DIR, "web-chat"));
    });

    it("returns profile-scoped web-chat directory for named profile", async () => {
      const { resolveWebChatDir, setUIActiveProfile, mockReadFile } =
        await importWorkspace();
      mockReadFile.mockReturnValue(JSON.stringify({}) as never);
      setUIActiveProfile("work");
      expect(resolveWebChatDir()).toBe(join(stateDirForProfile("work"), "web-chat"));
    });

    it("uses OPENCLAW_PROFILE when no UI override is set", async () => {
      process.env.OPENCLAW_PROFILE = "ironclaw";
      const { resolveWebChatDir, mockReadFile } = await importWorkspace();
      mockReadFile.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      expect(resolveWebChatDir()).toBe(join(stateDirForProfile("ironclaw"), "web-chat"));
    });

    it("migrates legacy web-chat-<profile> into profile state dir", async () => {
      const { resolveWebChatDir, setUIActiveProfile, mockExists, mockReadFile, mockRename } =
        await importWorkspace();
      mockReadFile.mockReturnValue(JSON.stringify({}) as never);
      setUIActiveProfile("work");

      const legacyDir = join(DEFAULT_STATE_DIR, "web-chat-work");
      const targetDir = join(stateDirForProfile("work"), "web-chat");
      mockExists.mockImplementation((p) => String(p) === legacyDir);

      resolveWebChatDir();

      expect(mockRename).toHaveBeenCalledWith(legacyDir, targetDir);
    });

    it("returns web-chat when profile is 'default'", async () => {
      const { resolveWebChatDir, setUIActiveProfile, mockReadFile } =
        await importWorkspace();
      mockReadFile.mockReturnValue(JSON.stringify({}) as never);
      setUIActiveProfile("default");
      expect(resolveWebChatDir()).toBe(join(DEFAULT_STATE_DIR, "web-chat"));
    });

    it("respects OPENCLAW_STATE_DIR override", async () => {
      process.env.OPENCLAW_STATE_DIR = "/custom/state";
      const { resolveWebChatDir, mockReadFile } = await importWorkspace();
      mockReadFile.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      expect(resolveWebChatDir()).toBe(join("/custom/state", "web-chat"));
    });

    it("uses default web-chat dir in non-test runtime when no profile is set", async () => {
      process.env.NODE_ENV = "production";
      process.env.VITEST = "false";
      const { resolveWebChatDir, mockReadFile } = await importWorkspace();
      mockReadFile.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      expect(resolveWebChatDir()).toBe(join(DEFAULT_STATE_DIR, "web-chat"));
    });
  });

  // ─── resolveWorkspaceRoot (profile-aware) ─────────────────────────

  describe("resolveWorkspaceRoot (profile-aware)", () => {
    it("returns profile-scoped workspace for named profile", async () => {
      const { resolveWorkspaceRoot, setUIActiveProfile, mockExists, mockReadFile } =
        await importWorkspace();
      mockReadFile.mockReturnValue(JSON.stringify({}) as never);
      setUIActiveProfile("work");
      const workDir = join(stateDirForProfile("work"), "workspace");
      mockExists.mockImplementation((p) => String(p) === workDir);
      expect(resolveWorkspaceRoot()).toBe(workDir);
    });

    it("uses OPENCLAW_PROFILE to resolve profile-scoped workspace", async () => {
      process.env.OPENCLAW_PROFILE = "ironclaw";
      const { resolveWorkspaceRoot, mockExists, mockReadFile } = await importWorkspace();
      mockReadFile.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      const profileWorkspaceDir = join(stateDirForProfile("ironclaw"), "workspace");
      mockExists.mockImplementation((p) => String(p) === profileWorkspaceDir);
      expect(resolveWorkspaceRoot()).toBe(profileWorkspaceDir);
    });

    it("prefers registry path over directory convention", async () => {
      const {
        resolveWorkspaceRoot,
        setUIActiveProfile,
        mockExists,
        mockReadFile,
      } = await importWorkspace();
      mockReadFile.mockReturnValue(
        JSON.stringify({
          workspaceRegistry: { work: "/custom/work" },
        }) as never,
      );
      setUIActiveProfile("work");
      mockExists.mockImplementation((p) => {
        const s = String(p);
        return (
          s === "/custom/work" || s === join(stateDirForProfile("work"), "workspace")
        );
      });
      expect(resolveWorkspaceRoot()).toBe("/custom/work");
    });

    it("OPENCLAW_WORKSPACE env takes top priority", async () => {
      process.env.OPENCLAW_WORKSPACE = "/env/workspace";
      const { resolveWorkspaceRoot, setUIActiveProfile, mockExists, mockReadFile } =
        await importWorkspace();
      mockReadFile.mockReturnValue(JSON.stringify({}) as never);
      setUIActiveProfile("work");
      mockExists.mockImplementation((p) => String(p) === "/env/workspace");
      expect(resolveWorkspaceRoot()).toBe("/env/workspace");
    });

    it("returns null when named profile workspace is missing", async () => {
      const { resolveWorkspaceRoot, setUIActiveProfile, mockExists, mockReadFile } =
        await importWorkspace();
      mockReadFile.mockReturnValue(JSON.stringify({}) as never);
      setUIActiveProfile("missing");
      mockExists.mockReturnValue(false);
      expect(resolveWorkspaceRoot()).toBeNull();
    });

    it("migrates legacy workspace-<profile> and updates resolution", async () => {
      const { resolveWorkspaceRoot, setUIActiveProfile, mockExists, mockReadFile, mockRename } =
        await importWorkspace();
      mockReadFile.mockReturnValue(
        JSON.stringify({
          workspaceRegistry: {
            work: join(DEFAULT_STATE_DIR, "workspace-work"),
          },
        }) as never,
      );
      setUIActiveProfile("work");

      const legacyDir = join(DEFAULT_STATE_DIR, "workspace-work");
      const targetDir = join(stateDirForProfile("work"), "workspace");
      let moved = false;
      mockExists.mockImplementation((p) => {
        const s = String(p);
        if (!moved) {
          return s === legacyDir;
        }
        return s === targetDir;
      });
      mockRename.mockImplementation(() => {
        moved = true;
      });

      expect(resolveWorkspaceRoot()).toBe(targetDir);
      expect(mockRename).toHaveBeenCalledWith(legacyDir, targetDir);
    });

    it("uses legacy workspace fallback when profile workspace is missing", async () => {
      const { resolveWorkspaceRoot, setUIActiveProfile, mockExists, mockReadFile, mockRename } =
        await importWorkspace();
      const legacyDir = join(DEFAULT_STATE_DIR, "workspace-ironclaw");
      mockReadFile.mockReturnValue(JSON.stringify({}) as never);
      setUIActiveProfile("ironclaw");
      mockRename.mockImplementation(() => {
        throw new Error("EPERM");
      });
      mockExists.mockImplementation((p) => String(p) === legacyDir);

      expect(resolveWorkspaceRoot()).toBe(legacyDir);
      expect(mockRename).toHaveBeenCalled();
    });
  });

  // ─── registerWorkspacePath / getRegisteredWorkspacePath ────────────

  describe("workspace registry", () => {
    it("registerWorkspacePath persists to state file", async () => {
      const { registerWorkspacePath, mockReadFile, mockWriteFile, mockExists } =
        await importWorkspace();
      mockReadFile.mockReturnValue(JSON.stringify({}) as never);
      mockExists.mockReturnValue(true);
      registerWorkspacePath("myprofile", "/my/workspace");
      const stateWrites = mockWriteFile.mock.calls.filter((c) =>
        (c[0] as string).includes(".ironclaw-ui-state.json"),
      );
      expect(stateWrites.length).toBeGreaterThan(0);
      const parsed = JSON.parse(stateWrites[stateWrites.length - 1][1] as string);
      expect(parsed.workspaceRegistry.myprofile).toBe("/my/workspace");
    });

    it("getRegisteredWorkspacePath returns null for unknown profile", async () => {
      const { getRegisteredWorkspacePath, mockReadFile } =
        await importWorkspace();
      mockReadFile.mockReturnValue(JSON.stringify({}) as never);
      expect(getRegisteredWorkspacePath("unknown")).toBeNull();
    });

    it("getRegisteredWorkspacePath returns null for null profile", async () => {
      const { getRegisteredWorkspacePath } = await importWorkspace();
      expect(getRegisteredWorkspacePath(null)).toBeNull();
    });

    it("getRegisteredWorkspacePath returns path for registered profile", async () => {
      const { getRegisteredWorkspacePath, mockReadFile } =
        await importWorkspace();
      mockReadFile.mockReturnValue(
        JSON.stringify({
          workspaceRegistry: { test: "/test/workspace" },
        }) as never,
      );
      expect(getRegisteredWorkspacePath("test")).toBe("/test/workspace");
    });

    it("registerWorkspacePath preserves existing registry entries", async () => {
      const { registerWorkspacePath, mockReadFile, mockWriteFile, mockExists } =
        await importWorkspace();
      mockReadFile.mockReturnValue(
        JSON.stringify({
          workspaceRegistry: { existing: "/existing" },
        }) as never,
      );
      mockExists.mockReturnValue(true);
      registerWorkspacePath("new", "/new/path");
      const stateWrites = mockWriteFile.mock.calls.filter((c) =>
        (c[0] as string).includes(".ironclaw-ui-state.json"),
      );
      expect(stateWrites.length).toBeGreaterThan(0);
      const parsed = JSON.parse(stateWrites[stateWrites.length - 1][1] as string);
      expect(parsed.workspaceRegistry.existing).toBe("/existing");
      expect(parsed.workspaceRegistry.new).toBe("/new/path");
    });
  });
});
