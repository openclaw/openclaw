import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const oauthMocks = vi.hoisted(() => ({ list: vi.fn() }));
const directoryReadState = vi.hoisted(() => ({
  unreadablePath: undefined as string | undefined,
  errorCode: "EBUSY",
}));

vi.mock("./github-oauth-records.js", () => ({ listGitHubOAuthRecords: oauthMocks.list }));
vi.mock("@openclaw/fs-safe/advanced", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/fs-safe/advanced")>();
  return {
    ...actual,
    readDirectoryIdentity: async (...args: Parameters<typeof actual.readDirectoryIdentity>) => {
      const [candidate] = args;
      if (candidate === directoryReadState.unreadablePath) {
        throw Object.assign(new Error("directory is unavailable"), {
          code: directoryReadState.errorCode,
        });
      }
      return actual.readDirectoryIdentity(...args);
    },
  };
});

import {
  resolveManagedGitHubAgentKey,
  resolveManagedGitHubProfileRoot,
} from "./github-tool-identity.js";
import { cleanupRetiredManagedGitHubProfiles } from "./github-tool-profile-cleanup.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function createProfile(root: string, profileId: string) {
  const profile = path.join(root, profileId);
  await fs.mkdir(profile, { recursive: true });
  await fs.writeFile(path.join(profile, "hosts.yml"), "github.com:\n");
  return profile;
}

describe("managed GitHub profile startup cleanup", () => {
  beforeEach(() => {
    oauthMocks.list.mockReset().mockReturnValue([]);
    directoryReadState.unreadablePath = undefined;
  });

  it.each(["EBUSY", "EPERM", "EIO", "ENOENT"])(
    "continues cleanup after an agent directory read fails with %s",
    async (errorCode) => {
      const stateDir = await fs.realpath(tempDirs.make("openclaw-github-cleanup-read-error-"));
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const systemRoot = resolveManagedGitHubProfileRoot({
        agentId: "system",
        scope: "system",
        env,
      });
      await fs.mkdir(path.join(systemRoot, "unexpected-entry"), { recursive: true });
      const agentIds = ["first", "middle", "last"].toSorted((left, right) =>
        resolveManagedGitHubAgentKey(left).localeCompare(resolveManagedGitHubAgentKey(right)),
      );
      const agentRoots = agentIds.map((agentId) =>
        resolveManagedGitHubProfileRoot({ agentId, scope: "agent", env }),
      );
      const [firstRoot, middleRoot, lastRoot] = agentRoots;
      assert(firstRoot && middleRoot && lastRoot);
      const profileId = "ghp_11111111111111111111111111111111";
      const [firstProfile, middleProfile, lastProfile] = await Promise.all([
        createProfile(firstRoot, profileId),
        createProfile(middleRoot, profileId),
        createProfile(lastRoot, profileId),
      ]);
      directoryReadState.unreadablePath = middleRoot;
      directoryReadState.errorCode = errorCode;

      const result = await cleanupRetiredManagedGitHubProfiles({
        config: { agents: { entries: Object.fromEntries(agentIds.map((id) => [id, {}])) } },
        env,
      });

      expect(result.removed).toBe(2);
      expect(result.warnings).toEqual([
        `ignored unexpected managed GitHub profile entry: ${path.join(systemRoot, "unexpected-entry")}`,
        ...(errorCode === "ENOENT"
          ? []
          : [
              `failed to read managed GitHub profile root: ${middleRoot}: Error: directory is unavailable`,
            ]),
      ]);
      await expect(fs.readFile(path.join(middleProfile, "hosts.yml"), "utf8")).resolves.toBe(
        "github.com:\n",
      );
      for (const profile of [firstProfile, lastProfile]) {
        await expect(fs.stat(profile)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );

  it("surfaces OAuth record failures without deleting profiles", async () => {
    const stateDir = await fs.realpath(tempDirs.make("openclaw-github-cleanup-oauth-error-"));
    const profile = await createProfile(
      path.join(stateDir, "credentials", "github", "system"),
      "ghp_11111111111111111111111111111111",
    );
    const error = new Error("OAuth records are unavailable");
    oauthMocks.list.mockRejectedValueOnce(error);

    await expect(
      cleanupRetiredManagedGitHubProfiles({ config: {}, env: { OPENCLAW_STATE_DIR: stateDir } }),
    ).rejects.toBe(error);
    expect(await fs.readFile(path.join(profile, "hosts.yml"), "utf8")).toBe("github.com:\n");
  });

  it("removes only unreferenced generations inside exact system and agent roots", async () => {
    const stateDir = await fs.realpath(tempDirs.make("openclaw-github-cleanup-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentDir = path.join(stateDir, "mutable-agent-dir");
    const systemRoot = resolveManagedGitHubProfileRoot({
      agentId: "system",
      scope: "system",
      env,
    });
    const agentRoot = resolveManagedGitHubProfileRoot({
      agentId: "reviewer",
      scope: "agent",
      env,
    });
    const systemCurrent = "ghp_11111111111111111111111111111111";
    const systemRetired = "ghp_22222222222222222222222222222222";
    const agentCurrent = "ghp_33333333333333333333333333333333";
    const agentRetired = "ghp_44444444444444444444444444444444";
    await Promise.all([
      createProfile(systemRoot, systemCurrent),
      createProfile(systemRoot, systemRetired),
      createProfile(agentRoot, agentCurrent),
      createProfile(agentRoot, agentRetired),
    ]);
    const stagingProfile = path.join(systemRoot, ".github-profile.staging-leftover", "profile");
    await fs.mkdir(stagingProfile, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(stagingProfile, "hosts.yml"), "github.com:\n", { mode: 0o600 });
    const outside = tempDirs.make("openclaw-github-cleanup-nested-link-");
    await fs.symlink(
      outside,
      path.join(systemRoot, systemRetired, "prior-export"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const result = await cleanupRetiredManagedGitHubProfiles({
      config: {
        tools: { github: { profileId: systemCurrent } },
        agents: {
          entries: {
            reviewer: {
              agentDir,
              tools: { github: { profileId: agentCurrent } },
            },
          },
        },
      },
      env,
    });

    expect(result.removed).toBe(3);
    await expect(fs.stat(path.join(systemRoot, systemCurrent))).resolves.toBeDefined();
    await expect(fs.stat(path.join(agentRoot, agentCurrent))).resolves.toBeDefined();
    await expect(fs.stat(path.join(systemRoot, systemRetired))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.stat(path.join(agentRoot, agentRetired))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      fs.stat(path.join(systemRoot, ".github-profile.staging-leftover")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(outside)).resolves.toBeDefined();
    expect(result.warnings).toEqual([]);
  });

  it.each(["root", "ancestor"])("preserves profiles behind a symlinked %s", async (alias) => {
    const stateDir = tempDirs.make("openclaw-github-cleanup-root-link-");
    const outside = tempDirs.make("openclaw-github-cleanup-root-target-");
    const credentials = path.join(outside, "credentials");
    const profileRoot = path.join(credentials, "github", "system");
    const profile = await createProfile(profileRoot, "ghp_55555555555555555555555555555555");
    await fs.mkdir(path.join(credentials, "github", "agents"));
    const target = alias === "root" ? profileRoot : credentials;
    const link =
      alias === "root"
        ? path.join(stateDir, "credentials", "github", "system")
        : path.join(stateDir, "credentials");
    await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");

    const result = await cleanupRetiredManagedGitHubProfiles({
      config: {},
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expect(result.removed).toBe(0);
    expect(result.warnings).toHaveLength(alias === "root" ? 1 : 2);
    expect(await fs.readFile(path.join(profile, "hosts.yml"), "utf8")).toBe("github.com:\n");
  });

  it.each(["unexpected", "symlink", "safe"])(
    "admits an entire orphan agent root before cleanup: %s",
    async (kind) => {
      const stateDir = await fs.realpath(
        tempDirs.make("openclaw-github-cleanup-orphan-admission-"),
      );
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const agentRoot = resolveManagedGitHubProfileRoot({
        agentId: "removed-agent",
        scope: "agent",
        env,
      });
      const profile = await createProfile(agentRoot, "ghp_11111111111111111111111111111111");
      if (kind === "unexpected") {
        await fs.writeFile(path.join(agentRoot, "zzz-unexpected"), "preserve\n");
      } else if (kind === "symlink") {
        await fs.symlink(
          tempDirs.make("openclaw-github-cleanup-orphan-link-"),
          path.join(agentRoot, "ghp_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"),
          process.platform === "win32" ? "junction" : "dir",
        );
      } else {
        await fs.mkdir(path.join(agentRoot, ".github-profile.staging-orphan", "profile"), {
          recursive: true,
        });
      }

      const result = await cleanupRetiredManagedGitHubProfiles({
        config: kind === "safe" ? { agents: { entries: { current: {} } } } : {},
        env,
      });

      if (kind === "safe") {
        expect(result).toEqual({ removed: 1, warnings: [] });
        await expect(fs.stat(agentRoot)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(result.removed).toBe(0);
        expect(result.warnings).toHaveLength(1);
        expect(await fs.readFile(path.join(profile, "hosts.yml"), "utf8")).toBe("github.com:\n");
        expect(await fs.readdir(agentRoot)).toHaveLength(2);
      }
    },
  );

  it("bounds warnings while preserving every unexpected profile entry", async () => {
    const stateDir = tempDirs.make("openclaw-github-cleanup-warning-cap-");
    const systemRoot = path.join(stateDir, "credentials", "github", "system");
    await fs.mkdir(systemRoot, { recursive: true });
    await Promise.all(
      Array.from({ length: 23 }, (_, index) => fs.mkdir(path.join(systemRoot, `unknown-${index}`))),
    );

    const result = await cleanupRetiredManagedGitHubProfiles({
      config: {},
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expect(result.removed).toBe(0);
    expect(result.warnings).toHaveLength(21);
    expect(result.warnings.at(-1)).toBe(
      "omitted 3 additional managed GitHub profile cleanup warnings",
    );
    expect(await fs.readdir(systemRoot)).toHaveLength(23);
  });

  it("preserves a durable recovery generation until its OAuth record retires", async () => {
    const stateDir = await fs.realpath(tempDirs.make("openclaw-github-cleanup-recovery-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const systemRoot = resolveManagedGitHubProfileRoot({
      agentId: "system",
      scope: "system",
      env,
    });
    const configured = "ghp_88888888888888888888888888888888";
    const recovery = "ghp_99999999999999999999999999999999";
    const retired = "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    await Promise.all([
      createProfile(systemRoot, configured),
      createProfile(systemRoot, recovery),
      createProfile(systemRoot, retired),
    ]);
    oauthMocks.list.mockReturnValue([
      {
        profileId: recovery,
        record: { profileId: recovery, scope: "system", agentId: "system" },
      },
    ]);

    const first = await cleanupRetiredManagedGitHubProfiles({
      config: { tools: { github: { profileId: configured } } },
      env,
    });

    expect(first).toEqual({ removed: 1, warnings: [] });
    await expect(fs.stat(path.join(systemRoot, configured))).resolves.toBeDefined();
    await expect(fs.stat(path.join(systemRoot, recovery))).resolves.toBeDefined();
    await expect(fs.stat(path.join(systemRoot, retired))).rejects.toMatchObject({ code: "ENOENT" });

    oauthMocks.list.mockReturnValue([]);
    const second = await cleanupRetiredManagedGitHubProfiles({
      config: { tools: { github: { profileId: configured } } },
      env,
    });
    expect(second).toEqual({ removed: 1, warnings: [] });
    await expect(fs.stat(path.join(systemRoot, recovery))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses symlink generations without touching their targets", async () => {
    const stateDir = await fs.realpath(tempDirs.make("openclaw-github-cleanup-link-"));
    const outside = await fs.realpath(tempDirs.make("openclaw-github-cleanup-outside-"));
    const systemRoot = path.join(stateDir, "credentials", "github", "system");
    const agentRegistry = path.join(stateDir, "credentials", "github", "agents");
    await fs.mkdir(systemRoot, { recursive: true });
    await fs.mkdir(agentRegistry, { recursive: true });
    const linkedProfile = "ghp_55555555555555555555555555555555";
    const linkedStaging = ".github-profile.staging-unsafe";
    await fs.symlink(outside, path.join(systemRoot, linkedProfile));
    await fs.symlink(outside, path.join(systemRoot, linkedStaging));
    const linkedAgentKey = resolveManagedGitHubAgentKey("removed-agent");
    await fs.symlink(outside, path.join(agentRegistry, linkedAgentKey));

    const result = await cleanupRetiredManagedGitHubProfiles({
      config: {},
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expect(result.removed).toBe(0);
    expect(result.warnings).toHaveLength(3);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining(linkedProfile),
        expect.stringContaining(linkedStaging),
        expect.stringContaining(linkedAgentKey),
      ]),
    );
    await expect(fs.stat(outside)).resolves.toBeDefined();
  });
});
