// Sandbox workspace tests cover bootstrap file seeding into isolated workspaces
// without following unsafe host links.
import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { readGatewayLockProcessNamespace } from "../../infra/gateway-lock-payload.js";
import { acquireGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { nodeFilePath } from "../../test-utils/node-file-path.js";
import * as workspaceCopy from "../workspace-bootstrap-copy.js";
import * as workspaceBootstrap from "../workspace-bootstrap-publish.js";
import { WorkspaceBootstrapSeedConflictError } from "../workspace-bootstrap-publish.js";
import { MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES } from "../workspace-bootstrap-read.js";
import { holdWorkspacePreparationSnapshot } from "../workspace-preparation-queue.test-support.js";
import { WorkspaceAliasRepointedError } from "../workspace-state-identity.js";
import * as workspaceOwner from "../workspace.js";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_SOUL_FILENAME,
  ensureSandboxWorkspace,
} from "../workspace.js";
import { captureSandboxStateOwner } from "./state-owner.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function workspaceFixture(files: Record<string, string> = {}) {
  const root = tempDirs.make("openclaw-sandbox-workspace-");
  const seed = path.join(root, "seed");
  const sandbox = path.join(root, "sandbox");
  await fs.mkdir(seed);
  await Promise.all(
    Object.entries(files).map(([name, text]) => fs.writeFile(path.join(seed, name), text)),
  );
  const read = (name = DEFAULT_AGENTS_FILENAME) => fs.readFile(path.join(sandbox, name), "utf8");
  return {
    root,
    seed,
    sandbox,
    read,
    agentsPath: path.join(sandbox, DEFAULT_AGENTS_FILENAME),
    prepare: () => ensureSandboxWorkspace(sandbox, seed, true),
    expectMissing: () => expect(read()).rejects.toThrow("no such file"),
  };
}

function waitForGate(
  gate: Promise<void>,
  task: Promise<unknown>,
  message: string,
  signal: AbortSignal,
) {
  return withinTest(awaitGateBeforeSettlement(gate, task, message), signal);
}

describe("ensureSandboxWorkspace", () => {
  it("rejects released hosted custody before bootstrap publication while queued or after a destination read", async ({
    signal,
  }) => {
    for (const phase of ["queued", "destination-read"] as const) {
      const {
        root,
        seed,
        sandbox,
        agentsPath: target,
      } = await workspaceFixture({
        [DEFAULT_AGENTS_FILENAME]: "seeded-agents",
      });
      await fs.mkdir(sandbox);
      await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
        const owner = acquireGatewayStateOwner({
          databasePath: resolveOpenClawStateSqlitePath(),
          payload: {
            pid: process.pid,
            processNamespace: readGatewayLockProcessNamespace(),
            createdAt: new Date().toISOString(),
            configPath: path.join(root, "openclaw.json"),
            role: "gateway",
          },
        });
        const guard = { assertHost: await captureSandboxStateOwner() };
        const replacementGuard = vi.fn();
        const entered = createDeferred();
        const resume = createDeferred();
        let held: ReturnType<typeof holdWorkspacePreparationSnapshot> | undefined;
        let leader: ReturnType<typeof workspaceOwner.ensureAgentWorkspace> | undefined;
        let preparation: Promise<void> | undefined;
        let restoreRead = () => {};
        try {
          if (phase === "queued") {
            held = holdWorkspacePreparationSnapshot(sandbox);
            leader = held.run(() => workspaceOwner.ensureAgentWorkspace({ dir: sandbox }));
            await held.ready(leader, signal);
          } else {
            const access = fs.access.bind(fs);
            const read = vi.spyOn(fs, "access").mockImplementation(async (...args) => {
              if (nodeFilePath(args[0]) === target) {
                entered.resolve();
                await resume.promise;
              }
              return access(...args);
            });
            restoreRead = () => read.mockRestore();
          }
          preparation = ensureSandboxWorkspace(sandbox, seed, true, undefined, guard);
          void preparation.catch(() => undefined);
          if (phase === "queued") {
            guard.assertHost = replacementGuard;
          } else {
            await waitForGate(
              entered.promise,
              preparation,
              "Bootstrap skipped destination read",
              signal,
            );
          }
          owner.release();
          resume.resolve();
          held?.release();
          if (leader) {
            await expect(leader).resolves.toMatchObject({ dir: sandbox });
          }
          const result = await preparation.catch((error: unknown) => error);
          expect(await fs.readdir(sandbox)).toEqual([]);
          expect(result).toMatchObject({ code: "GATEWAY_STATE_OWNER_REQUIRED" });
          if (phase === "queued") {
            expect(replacementGuard).not.toHaveBeenCalled();
          }
        } finally {
          resume.resolve();
          if (held) {
            await held.dispose([preparation]);
          } else {
            await preparation?.catch(() => {});
          }
          restoreRead();
          owner.release();
        }
      });
    }
  });

  it("keeps sandbox copying and scaffolding ahead of a later custom-purpose caller", async ({
    signal,
  }) => {
    const soul = "Synthetic sandbox persona.\n";
    const { seed, sandbox, read } = await workspaceFixture({ [DEFAULT_SOUL_FILENAME]: soul });
    const soulPath = path.join(sandbox, DEFAULT_SOUL_FILENAME);
    const purpose = "Late custom owner";
    const copied = createDeferred();
    const release = createDeferred();
    const publish = workspaceBootstrap.publishBootstrapFile;
    let held = false;
    const copy = vi
      .spyOn(workspaceBootstrap, "publishBootstrapFile")
      .mockImplementation(async (...args) => {
        const result = await publish(...args);
        if (!held && args[0] === soulPath) {
          held = true;
          copied.resolve();
          await release.promise;
        }
        return result;
      });
    const preparing = ensureSandboxWorkspace(sandbox, seed);
    void preparing.catch(() => undefined);
    let follower: ReturnType<typeof workspaceOwner.ensureAgentWorkspace> | undefined;
    try {
      await waitForGate(copied.promise, preparing, "Sandbox seed was not copied", signal);
      follower = workspaceOwner.ensureAgentWorkspace({ dir: sandbox, purpose });
      void follower.catch(() => undefined);
      release.resolve();
      await expect(preparing).resolves.toBeUndefined();
      await expect(follower).rejects.toBeInstanceOf(WorkspaceBootstrapSeedConflictError);
      await expect(follower).rejects.toThrow("Existing AGENTS.md was preserved");
      expect(await read()).not.toContain(purpose);
      expect(await read(DEFAULT_SOUL_FILENAME)).toBe(soul);
    } finally {
      release.resolve();
      await Promise.allSettled([preparing, follower]);
      copy.mockRestore();
    }
  });

  it("keeps the copied workspace identity through ordinary preparation", async () => {
    const content = "Synthetic seed instructions.\n";
    const { root, seed } = await workspaceFixture({ [DEFAULT_AGENTS_FILENAME]: content });
    const original = path.join(root, "original");
    const replacement = path.join(root, "replacement");
    const alias = path.join(root, "workspace");
    await Promise.all([original, replacement].map((dir) => fs.mkdir(dir)));
    const linkType = process.platform === "win32" ? "junction" : "dir";
    await fs.symlink(original, alias, linkType);
    const copy = workspaceCopy.copyWorkspaceBootstrapFiles;
    const handoff = vi
      .spyOn(workspaceCopy, "copyWorkspaceBootstrapFiles")
      .mockImplementationOnce(async (...args) => {
        await copy(...args);
        await fs.unlink(alias);
        await fs.symlink(replacement, alias, linkType);
      });
    try {
      await expect(ensureSandboxWorkspace(alias, seed, true)).rejects.toBeInstanceOf(
        WorkspaceAliasRepointedError,
      );
      expect(await fs.readFile(path.join(original, DEFAULT_AGENTS_FILENAME), "utf8")).toBe(content);
      expect(await fs.readdir(replacement)).toEqual([]);
    } finally {
      handoff.mockRestore();
    }
  });

  it.runIf(process.platform !== "win32")("skips symlinked bootstrap seed files", async () => {
    const { root, seed, prepare, expectMissing } = await workspaceFixture();
    const outside = path.join(root, "outside-secret.txt");
    await fs.writeFile(outside, "secret", "utf-8");
    await fs.symlink(outside, path.join(seed, DEFAULT_AGENTS_FILENAME));

    await prepare();
    await expectMissing();
  });

  it.runIf(process.platform !== "win32")("skips hardlinked bootstrap seed files", async () => {
    const { root, seed, prepare, expectMissing } = await workspaceFixture();
    const outside = path.join(root, "outside-agents.txt");
    const linkedSeed = path.join(seed, DEFAULT_AGENTS_FILENAME);
    await fs.writeFile(outside, "outside", "utf-8");
    try {
      await fs.link(outside, linkedSeed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EXDEV") {
        return;
      }
      throw error;
    }

    await prepare();
    await expectMissing();
  });

  it("skips an oversized seed file but still seeds the others", async () => {
    const { prepare, read, expectMissing } = await workspaceFixture({
      [DEFAULT_AGENTS_FILENAME]: `## Startup\n\n` + "x".repeat(MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES),
      [DEFAULT_SOUL_FILENAME]: "seeded-soul",
    });
    await prepare();
    await expectMissing();
    await expect(read(DEFAULT_SOUL_FILENAME)).resolves.toBe("seeded-soul");
  });

  it("seeds a bootstrap file at the byte read limit", async () => {
    const content = "## Startup\n\nDo startup things.\n";
    const padding = "x".repeat(MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES - content.length);
    const { prepare, read } = await workspaceFixture({
      [DEFAULT_AGENTS_FILENAME]: content + padding,
    });
    await prepare();
    expect(await read()).toContain("Do startup things");
  });

  it("does not publish a partial sandbox seed when the first write fails", async () => {
    const { sandbox, prepare, read, expectMissing } = await workspaceFixture({
      [DEFAULT_AGENTS_FILENAME]: "seeded-agents",
    });
    await fs.mkdir(sandbox, { recursive: true });
    const resolvedSandbox = await fs.realpath(sandbox);
    const realOpen = fs.open.bind(fs);
    let injected = false;
    const spy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      const rawPath = nodeFilePath(args[0]);
      const exclusiveCreate =
        typeof args[1] === "number" &&
        (args[1] & syncFs.constants.O_CREAT) !== 0 &&
        (args[1] & syncFs.constants.O_EXCL) !== 0;
      if (
        !injected &&
        rawPath &&
        path.dirname(path.resolve(rawPath)) === resolvedSandbox &&
        exclusiveCreate
      ) {
        vi.spyOn(handle, "write").mockImplementationOnce(async () => {
          injected = true;
          await handle.writeFile("# PARTIAL\n");
          throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
        });
      }
      return handle;
    });

    try {
      await expect(withEnvAsync({ FS_SAFE_NATIVE_MODE: "off" }, prepare)).rejects.toMatchObject({
        cause: { code: "ENOSPC" },
      });
      expect(injected).toBe(true);
      await expectMissing();
      expect(await fs.readdir(sandbox)).toEqual([]);
    } finally {
      spy.mockRestore();
    }

    await prepare();
    await expect(read()).resolves.toBe("seeded-agents");
  });
});
