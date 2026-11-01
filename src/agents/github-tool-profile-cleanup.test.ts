import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

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
const makeProfileId = (digit: string) => `ghp_${digit.repeat(32)}`;
const expectMissing = (file: string) =>
  expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
const expectPresent = (file: string) => expect(fs.stat(file)).resolves.toBeDefined();
const expectProfile = (profile: string) =>
  expect(fs.readFile(path.join(profile, "hosts.yml"), "utf8")).resolves.toBe("github.com:\n");
const linkDirectory = (target: string, link: string) =>
  fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");

async function createProfile(root: string, profileId: string) {
  const profile = path.join(root, profileId);
  await fs.mkdir(profile, { recursive: true });
  await fs.writeFile(path.join(profile, "hosts.yml"), "github.com:\n");
  return profile;
}

let stateDir: string;
let env: NodeJS.ProcessEnv;
let systemRoot: string;
const agentRootFor = (agentId: string) =>
  resolveManagedGitHubProfileRoot({ agentId, scope: "agent", env });
const createSystemProfiles = (ids: string[]) =>
  Promise.all(ids.map((id) => createProfile(systemRoot, id)));
const cleanup = (config: OpenClawConfig = {}) =>
  cleanupRetiredManagedGitHubProfiles({ config, env });
beforeEach(async () => {
  oauthMocks.list.mockReset().mockReturnValue([]);
  directoryReadState.unreadablePath = undefined;
  stateDir = await fs.realpath(tempDirs.make("openclaw-github-cleanup-"));
  env = { OPENCLAW_STATE_DIR: stateDir };
  systemRoot = resolveManagedGitHubProfileRoot({ agentId: "system", scope: "system", env });
});

it.each(["EBUSY", "ENOENT"])("continues after agent-root %s errors", async (errorCode) => {
  const agentIds = ["first", "middle", "last"].toSorted((left, right) =>
    resolveManagedGitHubAgentKey(left).localeCompare(resolveManagedGitHubAgentKey(right)),
  );
  const [firstRoot, middleRoot, lastRoot] = agentIds.map(agentRootFor);
  assert(firstRoot && middleRoot && lastRoot);
  const [firstProfile, middleProfile, lastProfile] = await Promise.all(
    [firstRoot, middleRoot, lastRoot].map((root) => createProfile(root, makeProfileId("1"))),
  );
  assert(firstProfile && middleProfile && lastProfile);
  directoryReadState.unreadablePath = middleRoot;
  directoryReadState.errorCode = errorCode;

  const result = await cleanup({
    agents: { entries: Object.fromEntries(agentIds.map((id) => [id, {}])) },
  });

  expect(result.warnings).toHaveLength(errorCode === "ENOENT" ? 0 : 1);
  await expectProfile(middleProfile);
  for (const profile of [firstProfile, lastProfile]) {
    await expectMissing(profile);
  }
});

it("surfaces OAuth record failures without deleting profiles", async () => {
  const profile = await createProfile(systemRoot, makeProfileId("1"));
  const error = new Error("OAuth records are unavailable");
  oauthMocks.list.mockRejectedValueOnce(error);

  await expect(cleanup()).rejects.toBe(error);
  await expectProfile(profile);
});

it("removes only unreferenced generations inside exact system and agent roots", async () => {
  const agentRoot = agentRootFor("reviewer");
  const systemCurrent = makeProfileId("1");
  const agentCurrent = makeProfileId("3");
  const retired = await createProfile(systemRoot, makeProfileId("2"));
  await createSystemProfiles([systemCurrent]);
  await Promise.all([agentCurrent, makeProfileId("4")].map((id) => createProfile(agentRoot, id)));
  await createProfile(path.join(systemRoot, ".github-profile.staging-leftover"), "profile");
  const outside = tempDirs.make("openclaw-github-cleanup-nested-link-");
  await linkDirectory(outside, path.join(retired, "prior-export"));

  const reviewer = {
    agentDir: path.join(stateDir, "mutable-agent-dir"),
    tools: { github: { profileId: agentCurrent } },
  };
  const result = await cleanup({
    tools: { github: { profileId: systemCurrent } },
    agents: { entries: { reviewer } },
  });

  expect(await fs.readdir(systemRoot)).toEqual([systemCurrent]);
  expect(await fs.readdir(agentRoot)).toEqual([agentCurrent]);
  await expectPresent(outside);
  expect(result.warnings).toEqual([]);
});

it.each(["root", "ancestor"])("preserves profiles behind a symlinked %s", async (alias) => {
  const outside = tempDirs.make("openclaw-github-cleanup-root-target-");
  const credentials = path.join(outside, "credentials");
  const profileRoot = path.join(credentials, "github", "system");
  const profile = await createProfile(profileRoot, makeProfileId("5"));
  await fs.mkdir(path.join(credentials, "github", "agents"));
  const relative = alias === "root" ? "credentials/github/system" : "credentials";
  const target = path.join(outside, relative);
  const link = path.join(stateDir, relative);
  await fs.mkdir(path.dirname(link), { recursive: true });
  await linkDirectory(target, link);

  const result = await cleanup();

  expect(result.warnings).toHaveLength(alias === "root" ? 1 : 2);
  await expectProfile(profile);
});

it.each(["unexpected", "symlink", "safe"])("admits the whole orphan root (%s)", async (kind) => {
  const agentRoot = agentRootFor("removed-agent");
  const profile = await createProfile(agentRoot, makeProfileId("1"));
  if (kind === "unexpected") {
    await fs.writeFile(path.join(agentRoot, "zzz-unexpected"), "preserve\n");
  } else if (kind === "symlink") {
    await linkDirectory(
      tempDirs.make("openclaw-github-cleanup-orphan-link-"),
      path.join(agentRoot, "ghp_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"),
    );
  } else {
    await fs.mkdir(path.join(agentRoot, ".github-profile.staging-orphan", "profile"), {
      recursive: true,
    });
  }

  const result = await cleanup(kind === "safe" ? { agents: { entries: { current: {} } } } : {});

  if (kind === "safe") {
    expect(result.warnings).toEqual([]);
    await expectMissing(agentRoot);
  } else {
    expect(result.warnings).toHaveLength(1);
    await expectProfile(profile);
    expect(await fs.readdir(agentRoot)).toHaveLength(2);
  }
});

it("bounds warnings while preserving every unexpected profile entry", async () => {
  await fs.mkdir(systemRoot, { recursive: true });
  await Promise.all(
    Array.from({ length: 23 }, (_, index) => fs.mkdir(path.join(systemRoot, `unknown-${index}`))),
  );

  const result = await cleanup();

  expect(result.warnings).toHaveLength(21);
  expect(result.warnings.at(-1)).toBe(
    "omitted 3 additional managed GitHub profile cleanup warnings",
  );
  expect(await fs.readdir(systemRoot)).toHaveLength(23);
});

it("preserves a durable recovery generation until its OAuth record retires", async () => {
  const configured = makeProfileId("8");
  const recovery = makeProfileId("9");
  await createSystemProfiles([configured, recovery, makeProfileId("a")]);
  const record = { profileId: recovery, scope: "system", agentId: "system" };
  oauthMocks.list.mockReturnValue([{ profileId: recovery, record }]);

  const config = { tools: { github: { profileId: configured } } };
  expect((await cleanup(config)).warnings).toEqual([]);
  expect((await fs.readdir(systemRoot)).toSorted()).toEqual([configured, recovery]);

  oauthMocks.list.mockReturnValue([]);
  expect((await cleanup(config)).warnings).toEqual([]);
  expect(await fs.readdir(systemRoot)).toEqual([configured]);
});

it("refuses symlink generations without touching their targets", async () => {
  const outside = await fs.realpath(tempDirs.make("openclaw-github-cleanup-outside-"));
  const agentRegistry = path.join(stateDir, "credentials", "github", "agents");
  await fs.mkdir(systemRoot, { recursive: true });
  await fs.mkdir(agentRegistry, { recursive: true });
  const linkedProfile = makeProfileId("5");
  const linkedStaging = ".github-profile.staging-unsafe";
  await Promise.all(
    [linkedProfile, linkedStaging].map((name) => fs.symlink(outside, path.join(systemRoot, name))),
  );
  const linkedAgentKey = resolveManagedGitHubAgentKey("removed-agent");
  await fs.symlink(outside, path.join(agentRegistry, linkedAgentKey));

  const result = await cleanup();

  expect(result.warnings).toHaveLength(3);
  for (const name of [linkedProfile, linkedStaging, linkedAgentKey]) {
    expect(result.warnings).toContainEqual(expect.stringContaining(name));
  }
  await expectPresent(outside);
});
