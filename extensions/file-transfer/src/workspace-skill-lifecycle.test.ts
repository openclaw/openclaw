import fs from "node:fs/promises";
import path from "node:path";
import { getAgentWorkspaceAccess } from "openclaw/plugin-sdk/agent-workspace-runtime";
import type {
  OpenClawPluginApi,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
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
beforeEach(async () => {
  scheduler = createTestPluginServiceScheduler();
  const parent = await fs.realpath(tempDirs.make("node-skill-lifecycle-"));
  local = path.join(parent, "gateway");
  remote = path.join(parent, "harness");
  await fs.mkdir(local);
  await fs.mkdir(remote);
  nodePolicy = {
    allowReadPaths: [remote, `${remote}/**`],
    allowWritePaths: [],
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
  registerNodeWorkspaces(api);
});
afterEach(async () => {
  scheduler.beginClose();
  try {
    await service.stop?.(context());
  } finally {
    await scheduler.stop();
  }
});
function skillRequest() {
  return {
    sourcePlan: {
      workspaceDir: local,
      managedSkillsDir: path.join(local, "managed"),
      roots: [
        {
          dir: path.join(local, "skills"),
          source: "openclaw-workspace" as const,
          tier: "workspace" as const,
        },
      ],
      pluginSkillRoots: [],
    },
    limits: { maxCandidatesPerRoot: 100, maxSkillsLoadedPerSource: 100, maxSkillFileBytes: 65536 },
    additionalBins: [],
  };
}

it("publishes, tracks, updates and removes Skills on the paired host with Gateway policy", async () => {
  nodePolicy.allowWritePaths.push(
    `${remote}/skills`,
    `${remote}/skills/**`,
    `${remote}/.clawhub/**`,
    `${remote}/.clawdhub/**`,
    `${remote}/.openclaw/skill-installs/**`,
  );
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
  const source = path.join(local, "download");
  await fs.mkdir(source);
  const skill = (version: string) =>
    `---\nname: lifecycle-proof\ndescription: Skill lifecycle proof\n---\nPrint ${version}.\n`;
  await fs.writeFile(path.join(source, "SKILL.md"), skill("v1"));
  await fs.writeFile(path.join(source, "run.sh"), "#!/bin/sh\necho lifecycle-proof\n", {
    mode: 0o755,
  });
  const install = {
    workspaceDir: local,
    extractedRoot: source,
    slug: "lifecycle-proof",
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
  await expect(fs.stat(path.join(remote, "skills/lifecycle-proof"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  const approved = vi.fn(async () => undefined);
  const installed = await access.applySkillRoot!({ ...install, beforeInstall: approved });
  expect(installed).toMatchObject({
    ok: true,
    mode: "install",
    targetDir: path.join(remote, "skills/lifecycle-proof"),
  });
  expect(approved).toHaveBeenCalledWith("install");
  const targetDir = path.join(remote, "skills/lifecycle-proof");
  expect((await fs.stat(path.join(targetDir, "run.sh"))).mode & 0o111).toBe(0o111);
  await access.recordSkillSourceInstall!({
    workspaceDir: local,
    targetDir,
    origin: { version: 1, source: "path", spec: source, slug: "lifecycle-proof", installedAt: 1 },
  });
  expect(
    JSON.parse(await fs.readFile(path.join(targetDir, ".openclaw/source-origin.json"), "utf8")),
  ).toMatchObject({ slug: "lifecycle-proof" });
  // ClawHub metadata lives with the real workspace and drives native update/removal guards.
  const tracking = access.clawHubSkills!;
  const record = async (version: string) => {
    const files = await tracking.readInstalledClawHubSkillFiles({ skillDir: targetDir });
    await tracking.recordClawHubSkillInstall({
      workspaceDir: local,
      skillDir: targetDir,
      origin: {
        version: 1,
        slug: "lifecycle-proof",
        registry: "https://example.test",
        installedVersion: version,
        installedAt: 1,
        ...files,
      },
    });
  };
  await record("1.0.0");
  nodePolicy.denyPaths = [targetDir];
  await expect(
    tracking.resolveClawHubSkillVerificationTarget({
      workspaceDir: local,
      slug: "lifecycle-proof",
    }),
  ).rejects.toThrow("POLICY_DENIED");
  delete nodePolicy.denyPaths;
  const moved = `${targetDir}-moved`;
  await fs.rename(targetDir, moved);
  await fs.symlink(moved, targetDir);
  await expect(
    tracking.resolveClawHubSkillVerificationTarget({
      workspaceDir: local,
      slug: "lifecycle-proof",
    }),
  ).rejects.toThrow("resolved location");
  await fs.unlink(targetDir);
  await fs.rename(moved, targetDir);

  expect((await tracking.readClawHubSkillsLockfile(local)).skills["lifecycle-proof"]?.version).toBe(
    "1.0.0",
  );
  expect(
    (await access.loadSkills!(skillRequest())).entries.some(
      (entry) => entry.skill.name === "lifecycle-proof",
    ),
  ).toBe(true);
  await expect(fs.stat(path.join(local, "skills/lifecycle-proof"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await fs.writeFile(path.join(targetDir, "SKILL.md"), skill("owner edit"));
  expect(
    await tracking.guardTrackedSkillLocalState({
      workspaceDir: local,
      slug: "lifecycle-proof",
      previousVersion: "1.0.0",
    }),
  ).toMatchObject({ ok: false });
  await fs.writeFile(path.join(targetDir, "SKILL.md"), skill("v1"));
  const guard = await tracking.guardTrackedSkillLocalState({
    workspaceDir: local,
    slug: "lifecycle-proof",
    previousVersion: "1.0.0",
  });
  expect(guard.ok).toBe(true);
  if (!guard.ok) {
    throw new Error(guard.error);
  }
  await fs.writeFile(path.join(source, "SKILL.md"), skill("v2"));
  // Revoke after the old target has moved to backup, before publishing its replacement.
  // Native rollback must preserve the old Skill even though the initial policy check passed.
  publicationsBeforeRevocation = 2;
  expect(
    await access.applySkillRoot!({
      ...install,
      mode: "update",
      expectedClawHubState: guard.plan,
      beforeInstall: approved,
      beforePersistentApply: () => {
        if (!current) {
          throw new Error("upload permission revoked");
        }
      },
    }),
  ).toMatchObject({ ok: false, error: expect.stringContaining("upload permission revoked") });
  expect(await fs.readFile(path.join(targetDir, "SKILL.md"), "utf8")).toBe(skill("v1"));
  current = true;
  expect(
    await access.applySkillRoot!({
      ...install,
      mode: "update",
      expectedClawHubState: guard.plan,
      beforeInstall: approved,
    }),
  ).toMatchObject({ ok: true, mode: "update" });
  await record("2.0.0");
  expect(await fs.readFile(path.join(targetDir, "SKILL.md"), "utf8")).toBe(skill("v2"));
  const removal = await tracking.planClawHubSkillUninstall({
    workspaceDir: local,
    slug: "lifecycle-proof",
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
  await expect(fs.stat(targetDir)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await tracking.readClawHubSkillsLockfile(local)).skills).toEqual({});
  expect(await fs.readdir(path.join(remote, ".openclaw/skill-installs"))).toEqual([]);
});

it("retires uploaded Skill source when authority ends before installation starts", async () => {
  nodePolicy.allowWritePaths.push(
    `${remote}/skills`,
    `${remote}/skills/**`,
    `${remote}/.openclaw/skill-installs/**`,
  );
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
      beforePersistentApply: () => {
        if (!current) {
          throw new Error("install authority ended");
        }
      },
    }),
  ).rejects.toThrow("install authority ended");
  await operationClosed;
  expect(await fs.readdir(path.join(remote, ".openclaw/skill-installs"))).toEqual([]);
  await expect(fs.stat(path.join(remote, "skills/interrupted"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
