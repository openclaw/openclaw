import fs from "node:fs/promises";
import path from "node:path";
import { getAgentWorkspaceAccess as getAccess } from "openclaw/plugin-sdk/agent-workspace-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createWorkspaceFixture,
  expectMissing,
  workspaceSkillRequest,
  type WorkspaceFixture,
} from "./workspace-fixture.test-support.js";
import { registerNodeWorkspaces } from "./workspace-service.js";
import { createNodeWorkspaceTestTransport as createTransport } from "./workspace-service.test-support.js";

vi.mock("./shared/audit.js", () => ({ appendFileTransferAudit: vi.fn() }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let f: WorkspaceFixture;
const slug = "lifecycle-proof";

function assertCurrent(current: boolean, message: string) {
  if (!current) {
    throw new Error(message);
  }
}
beforeEach(async () => {
  const parent = await fs.realpath(tempDirs.make("node-skill-lifecycle-"));
  f = await createWorkspaceFixture(parent);
  f.nodePolicy.allowWritePaths.push(
    `${f.remote}/skills`,
    `${f.remote}/skills/**`,
    `${f.remote}/.openclaw/skill-installs/**`,
  );
  setRuntimeConfigSnapshot(f.api.config);
  registerNodeWorkspaces(f.api);
});
afterEach(async () => {
  f.scheduler.beginClose();
  try {
    await f.service.stop?.(f.context());
  } finally {
    try {
      await f.scheduler.stop();
    } finally {
      clearRuntimeConfigSnapshot();
    }
  }
});
const skillRequest = () => workspaceSkillRequest(f.local);

it("publishes, tracks, updates and removes Skills on the paired host with Gateway policy", async () => {
  f.nodePolicy.allowWritePaths.push(`${f.remote}/.clawhub/**`, `${f.remote}/.clawdhub/**`);
  let publicationsBeforeRevocation = 0;
  let current = true;
  f.openDuplex = createTransport(f.api, f.remote, undefined, (bytes) => {
    if (
      publicationsBeforeRevocation > 0 &&
      Buffer.from(bytes).toString("utf8").includes('"phase":"apply"') &&
      --publicationsBeforeRevocation === 0
    ) {
      current = false;
    }
  });
  await f.service.start(f.context());
  const access = getAccess(f.local)!;
  const identity = { workspaceDir: f.local, slug };
  const targetDir = path.join(f.remote, "skills", slug);
  const skillFile = path.join(targetDir, "SKILL.md");
  const source = path.join(f.local, "download");
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
    workspaceDir: f.local,
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
      workspaceDir: f.local,
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
  f.nodePolicy.denyPaths = [targetDir];
  await expect(tracking.resolveClawHubSkillVerificationTarget(identity)).rejects.toThrow(
    "POLICY_DENIED",
  );
  delete f.nodePolicy.denyPaths;
  const moved = `${targetDir}-moved`;
  await fs.rename(targetDir, moved);
  await fs.symlink(moved, targetDir);
  await expect(tracking.resolveClawHubSkillVerificationTarget(identity)).rejects.toThrow(
    "resolved location",
  );
  await fs.unlink(targetDir);
  await fs.rename(moved, targetDir);

  expect((await tracking.readClawHubSkillsLockfile(f.local)).skills[slug]?.version).toBe("1.0.0");
  expect(
    (await access.loadSkills!(skillRequest())).entries.some((entry) => entry.skill.name === slug),
  ).toBe(true);
  await expectMissing(path.join(f.local, "skills", slug));
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
    expect.objectContaining({ workspaceDir: f.local, action: "removed" }),
  );
  await expectMissing(targetDir);
  expect((await tracking.readClawHubSkillsLockfile(f.local)).skills).toEqual({});
  expect(await fs.readdir(path.join(f.remote, ".openclaw/skill-installs"))).toEqual([]);
});

it("retires uploaded Skill source when authority ends before installation starts", async () => {
  let current = true;
  let operationClosed: Promise<unknown> | undefined;
  const transport = createTransport(f.api, f.remote);
  f.openDuplex = async (request) => {
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
  await f.service.start(f.context());
  const source = path.join(f.local, "download");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "SKILL.md"), "---\nname: interrupted\n---\nDo nothing.\n");
  await expect(
    getAccess(f.local)!.applySkillRoot!({
      workspaceDir: f.local,
      extractedRoot: source,
      slug: "interrupted",
      mode: "install",
      beforePersistentApply: () => assertCurrent(current, "install authority ended"),
    }),
  ).rejects.toThrow("install authority ended");
  await operationClosed;
  expect(await fs.readdir(path.join(f.remote, ".openclaw/skill-installs"))).toEqual([]);
  await expectMissing(path.join(f.remote, "skills/interrupted"));
});
