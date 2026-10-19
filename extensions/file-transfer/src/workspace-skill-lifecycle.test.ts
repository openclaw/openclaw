import fs from "node:fs/promises";
import path from "node:path";
import {
  type AgentWorkspaceAccess,
  getAgentWorkspaceAccess,
} from "openclaw/plugin-sdk/agent-workspace-runtime";
import type {
  OpenClawPluginApi,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerNodeWorkspaces } from "./workspace-service.js";
import { createNodeWorkspaceTestTransport } from "./workspace-service.test-support.js";

vi.mock("./shared/audit.js", () => ({ appendFileTransferAudit: vi.fn() }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let local: string;
let remote: string;
let service: Parameters<OpenClawPluginApi["registerService"]>[0];
let scheduler: ReturnType<typeof createTestPluginServiceScheduler>;
let api: OpenClawPluginApi;
let nodePolicy: {
  allowReadPaths: string[];
  allowWritePaths: string[];
  denyPaths?: string[];
  followSymlinks: boolean;
  ask: "off";
};
let openDuplex: OpenClawPluginServiceContext["openNodeDuplex"];
const slug = "lifecycle-proof";
const invoke = vi.fn(async () => {
  throw new Error("Lifecycle must use the paired stream");
});
function context() {
  return {
    config: api.config,
    logger: api.logger,
    stateDir: local,
    invokeNode: invoke,
    openNodeDuplex: openDuplex,
    scheduler,
  };
}
async function expectMissing(file: string) {
  await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
}

function assertCurrent(current: boolean, message: string) {
  if (!current) {
    throw new Error(message);
  }
}
beforeEach(async () => {
  scheduler = createTestPluginServiceScheduler();
  const parent = await fs.realpath(tempDirs.make("node-skill-lifecycle-"));
  local = path.join(parent, "gateway");
  remote = path.join(parent, "harness");
  await fs.mkdir(local);
  await fs.mkdir(remote);
  nodePolicy = {
    allowReadPaths: [remote, `${remote}/**`],
    allowWritePaths: [
      `${remote}/skills`,
      `${remote}/skills/**`,
      `${remote}/.openclaw/skill-installs/**`,
    ],
    followSymlinks: false,
    ask: "off",
  };
  const pluginConfig = {
    policyVersion: 2,
    workspaces: { main: { nodeId: "node-1", remoteRoot: remote } },
    nodes: { "node-1": nodePolicy },
  };
  api = createTestPluginApi({
    registrationMode: "full",
    config: { plugins: { entries: { "file-transfer": { config: pluginConfig } } } },
    pluginConfig,
    runtime: {
      agent: { resolveAgentWorkspaceDir: () => local },
      nodes: { invoke },
    } as unknown as OpenClawPluginApi["runtime"],
    registerService: (value) => {
      service = value;
    },
  });
  setRuntimeConfigSnapshot(api.config);
  registerNodeWorkspaces(api);
});
afterEach(async () => {
  scheduler.beginClose();
  try {
    await service.stop?.(context());
  } finally {
    try {
      await scheduler.stop();
    } finally {
      clearRuntimeConfigSnapshot();
    }
  }
});
function skillRequest(): Parameters<NonNullable<AgentWorkspaceAccess["loadSkills"]>>[0] {
  return {
    sourcePlan: {
      workspaceDir: local,
      managedSkillsDir: path.join(local, "managed"),
      roots: [{ dir: path.join(local, "skills"), source: "openclaw-workspace", tier: "workspace" }],
      pluginSkillRoots: [],
    },
    limits: { maxCandidatesPerRoot: 100, maxSkillsLoadedPerSource: 100, maxSkillFileBytes: 65536 },
    additionalBins: [],
  };
}

it("publishes, tracks, updates and removes Skills on the paired host with Gateway policy", async () => {
  nodePolicy.allowWritePaths.push(`${remote}/.clawhub/**`, `${remote}/.clawdhub/**`);
  let publicationsBeforeRevocation = 0;
  let current = true;
  openDuplex = createNodeWorkspaceTestTransport(api, remote, undefined, (bytes) => {
    if (
      publicationsBeforeRevocation > 0 &&
      Buffer.from(bytes).toString("utf8").includes('"phase":"apply"') &&
      --publicationsBeforeRevocation === 0
    ) {
      current = false;
    }
  });
  await service.start(context());
  const access = getAgentWorkspaceAccess(local)!;
  const identity = { workspaceDir: local, slug };
  const targetDir = path.join(remote, "skills", slug);
  const skillFile = path.join(targetDir, "SKILL.md");
  const source = path.join(local, "download");
  await fs.mkdir(source);
  const skill = (version: string) =>
    `---\nname: lifecycle-proof\ndescription: Skill lifecycle proof\n---\nPrint ${version}.\n`;
  await fs.writeFile(path.join(source, "SKILL.md"), skill("v1"));
  await fs.writeFile(path.join(source, "run.sh"), "#!/bin/sh\necho lifecycle-proof\n", {
    mode: 0o755,
  });
  const install = {
    ...identity,
    extractedRoot: source,
    mode: "install" as const,
  };
  // The real worker reaches publication only after the Gateway answers this checkpoint.
  const denied = await access.applySkillRoot!({
    ...install,
    beforeInstall: async () => ({
      error: "Policy denies this source",
      failureKind: "invalid-request",
    }),
  });
  expect(denied).toMatchObject({ ok: false, error: "Policy denies this source" });
  await expectMissing(targetDir);
  const approved = vi.fn(async () => undefined);
  const installed = await access.applySkillRoot!({ ...install, beforeInstall: approved });
  expect(installed).toMatchObject({ ok: true, mode: "install", targetDir });
  expect(approved).toHaveBeenCalledWith("install");
  expect((await fs.stat(path.join(targetDir, "run.sh"))).mode & 0o111).toBe(0o111);
  await access.recordSkillSourceInstall!({
    workspaceDir: local,
    targetDir,
    origin: { version: 1, source: "path", spec: source, slug, installedAt: 1 },
  });
  expect(
    JSON.parse(await fs.readFile(path.join(targetDir, ".openclaw/source-origin.json"), "utf8")),
  ).toMatchObject({ slug });
  // ClawHub metadata lives with the real workspace and drives native update/removal guards.
  const tracking = access.clawHubSkills!;
  const record = async (version: string) => {
    const files = await tracking.readInstalledClawHubSkillFiles({ skillDir: targetDir });
    await tracking.recordClawHubSkillInstall({
      workspaceDir: local,
      skillDir: targetDir,
      origin: {
        version: 1,
        slug,
        registry: "https://example.test",
        installedVersion: version,
        installedAt: 1,
        ...files,
      },
    });
  };
  await record("1.0.0");
  nodePolicy.denyPaths = [targetDir];
  await expect(tracking.resolveClawHubSkillVerificationTarget(identity)).rejects.toThrow(
    "POLICY_DENIED",
  );
  delete nodePolicy.denyPaths;
  const moved = `${targetDir}-moved`;
  await fs.rename(targetDir, moved);
  await fs.symlink(moved, targetDir);
  await expect(tracking.resolveClawHubSkillVerificationTarget(identity)).rejects.toThrow(
    "resolved location",
  );
  await fs.unlink(targetDir);
  await fs.rename(moved, targetDir);

  expect((await tracking.readClawHubSkillsLockfile(local)).skills[slug]?.version).toBe("1.0.0");
  expect(
    (await access.loadSkills!(skillRequest())).entries.some((entry) => entry.skill.name === slug),
  ).toBe(true);
  await expectMissing(path.join(local, "skills", slug));
  const guardRequest = { ...identity, previousVersion: "1.0.0" };
  await fs.writeFile(skillFile, skill("owner edit"));
  expect(await tracking.guardTrackedSkillLocalState(guardRequest)).toMatchObject({ ok: false });
  await fs.writeFile(skillFile, skill("v1"));
  const guard = await tracking.guardTrackedSkillLocalState(guardRequest);
  expect(guard.ok).toBe(true);
  if (!guard.ok) {
    throw new Error(guard.error);
  }
  await fs.writeFile(path.join(source, "SKILL.md"), skill("v2"));
  // Revoke after the old target has moved to backup, before publishing its replacement.
  // Native rollback must preserve the old Skill even though the initial policy check passed.
  publicationsBeforeRevocation = 2;
  const update = {
    ...install,
    mode: "update" as const,
    expectedClawHubState: guard.plan,
    beforeInstall: approved,
  };
  expect(
    await access.applySkillRoot!({
      ...update,
      beforePersistentApply: () => assertCurrent(current, "upload permission revoked"),
    }),
  ).toMatchObject({ ok: false, error: expect.stringContaining("upload permission revoked") });
  expect(await fs.readFile(skillFile, "utf8")).toBe(skill("v1"));
  current = true;
  expect(await access.applySkillRoot!(update)).toMatchObject({ ok: true, mode: "update" });
  await record("2.0.0");
  expect(await fs.readFile(skillFile, "utf8")).toBe(skill("v2"));
  const removal = await tracking.planClawHubSkillUninstall({
    ...identity,
    expectedVersion: "2.0.0",
  });
  expect(removal.ok).toBe(true);
  if (!removal.ok) {
    throw new Error(removal.error);
  }
  const authorize = vi.fn();
  const changed = vi.fn(async () => {});
  expect(
    await tracking.applyClawHubSkillUninstall(removal.plan, {
      beforePersistentApply: authorize,
      onCommittedChange: changed,
    }),
  ).toEqual({ ok: true });
  expect(authorize).toHaveBeenCalled();
  expect(changed).toHaveBeenCalledWith(
    expect.objectContaining({ workspaceDir: local, action: "removed" }),
  );
  await expectMissing(targetDir);
  expect((await tracking.readClawHubSkillsLockfile(local)).skills).toEqual({});
  expect(await fs.readdir(path.join(remote, ".openclaw/skill-installs"))).toEqual([]);
});

it("retires uploaded Skill source when authority ends before installation starts", async () => {
  let current = true;
  let operationClosed: Promise<unknown> | undefined;
  const transport = createNodeWorkspaceTestTransport(api, remote);
  openDuplex = async (request) => {
    const channel = await transport(request);
    if (request.command === "workspace.skills") {
      operationClosed = channel.closed.catch(() => {});
    }
    return request.command === "file.create"
      ? {
          ...channel,
          closed: channel.closed.then((result) => {
            current = false;
            return result;
          }),
        }
      : channel;
  };
  await service.start(context());
  const source = path.join(local, "download");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "SKILL.md"), "---\nname: interrupted\n---\nDo nothing.\n");
  await expect(
    getAgentWorkspaceAccess(local)!.applySkillRoot!({
      workspaceDir: local,
      extractedRoot: source,
      slug: "interrupted",
      mode: "install",
      beforePersistentApply: () => assertCurrent(current, "install authority ended"),
    }),
  ).rejects.toThrow("install authority ended");
  await operationClosed;
  expect(await fs.readdir(path.join(remote, ".openclaw/skill-installs"))).toEqual([]);
  await expectMissing(path.join(remote, "skills/interrupted"));
});
