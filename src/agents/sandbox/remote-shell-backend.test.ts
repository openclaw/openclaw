import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { hasErrnoCode } from "../../infra/errno.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { createRemoteShellSandboxBackend } from "./remote-shell-backend.js";
import {
  createRemoteShellSandboxSession,
  type RemoteShellSandboxSession,
} from "./remote-shell-transport.js";

type RemoteShellUploadParams = Parameters<RemoteShellSandboxSession["uploadDirectory"]>[0];

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function createFixture() {
  const root = await fs.realpath(tempDirs.make("remote-shell-bootstrap-"));
  const remoteRoot = path.join(root, "remote");
  const partialDir = path.join(root, "partial");
  await fs.mkdir(partialDir);
  await fs.writeFile(path.join(partialDir, "partial.txt"), "incomplete transfer");
  const cfg = resolveSandboxConfigForAgent(
    {
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            backend: "ssh",
            scope: "session",
            workspaceAccess: "rw",
            ssh: { target: "unused", workspaceRoot: remoteRoot },
          },
        },
      },
    },
    "test",
  );
  const createBackend = async (
    label: string,
    upload?: (
      params: RemoteShellUploadParams,
      run: (params: RemoteShellUploadParams) => Promise<void>,
    ) => Promise<void>,
  ) => {
    const workspaceDir = path.join(root, label, "workspace");
    const agentWorkspaceDir = path.join(root, label, "agent");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(agentWorkspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "full.txt"), `${label}-primary`);
    await fs.writeFile(path.join(agentWorkspaceDir, "full.txt"), `${label}-agent`);
    return createRemoteShellSandboxBackend(
      {
        cfg,
        scopeKey: "shared-scope",
        sessionKey: "test",
        workspaceDir,
        agentWorkspaceDir,
      },
      {
        createSession: async () => {
          const session = createRemoteShellSandboxSession({
            buildCommand: ({ remoteCommand }) => ({
              argv: ["/bin/sh", "-c", remoteCommand],
              env: process.env,
            }),
          });
          return {
            ...session,
            uploadDirectory: (params) =>
              upload
                ? upload(params, (input) => session.uploadDirectory(input))
                : session.uploadDirectory(params),
          };
        },
      },
    );
  };
  const protectedDir = path.join(root, "protected");
  const restrictiveDirectories: string[] = [];
  const makeStageReadOnly = async (directory: string) => {
    const child = path.join(directory, "readonly");
    const nested = path.join(child, "nested");
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(nested, "payload"), "readonly payload");
    await fs.mkdir(protectedDir, { recursive: true });
    await fs.writeFile(path.join(protectedDir, "untouched"), "outside stage");
    await fs.chmod(protectedDir, 0o555);
    await fs.symlink(protectedDir, path.join(child, "outside"));
    restrictiveDirectories.push(directory, child, nested);
    await fs.chmod(nested, 0o400);
    await fs.chmod(child, 0o400);
    await fs.chmod(directory, 0o400);
  };
  const restorePermissions = async () => {
    for (const directory of [...restrictiveDirectories, protectedDir]) {
      await fs.chmod(directory, 0o700).catch((error: unknown) => {
        if (!hasErrnoCode(error, "ENOENT")) {
          throw error;
        }
      });
    }
  };
  const assertProtectedUnchanged = async () => {
    expect((await fs.stat(protectedDir)).mode & 0o777).toBe(0o555);
    expect(await fs.readFile(path.join(protectedDir, "untouched"), "utf8")).toBe("outside stage");
  };
  return {
    remoteRoot,
    partialDir,
    createBackend,
    makeStageReadOnly,
    restorePermissions,
    assertProtectedUnchanged,
  };
}

describe.runIf(process.platform === "linux" || process.platform === "darwin")(
  "remote workspace initialization",
  () => {
    it.each([
      { interrupted: "workspace", readOnly: false },
      { interrupted: "agent", readOnly: false },
      { interrupted: "workspace", readOnly: true },
      { interrupted: "agent", readOnly: true },
    ])(
      "retries incomplete $interrupted uploads without publishing a partial workspace (readonly=$readOnly)",
      async ({ interrupted, readOnly }) => {
        const fixture = await createFixture();
        let failed = false;
        const backend = await fixture.createBackend("source", async (params, upload) => {
          if (!failed && path.basename(params.remoteDir) === interrupted) {
            failed = true;
            await upload({ ...params, localDir: fixture.partialDir });
            if (readOnly) {
              await fixture.makeStageReadOnly(params.remoteDir);
            }
            throw new Error("interrupted initial upload");
          }
          await upload(params);
        });
        try {
          const root = path.dirname(backend.workdir);
          await expect(backend.runShellCommand({ script: "true" })).rejects.toThrow(
            "interrupted initial upload",
          );
          await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
          expect(await fs.readdir(fixture.remoteRoot)).toEqual([]);
          if (readOnly) {
            await fixture.assertProtectedUnchanged();
          }
          await backend.runShellCommand({ script: "true" });
          expect(await fs.readFile(path.join(backend.workdir, "full.txt"), "utf8")).toBe(
            "source-primary",
          );
          expect(await fs.readFile(path.join(root, "agent", "full.txt"), "utf8")).toBe(
            "source-agent",
          );
          expect(await fs.readdir(backend.workdir)).toEqual(["full.txt"]);
          expect(await fs.readdir(fixture.remoteRoot)).toEqual([path.basename(root)]);
        } finally {
          await fixture.restorePermissions();
        }
      },
    );

    it.each([
      { winner: "edited", readOnlyLoser: false },
      { winner: "emptied", readOnlyLoser: false },
      { winner: "edited", readOnlyLoser: true },
    ])(
      "keeps a concurrently published $winner workspace (readonly loser=$readOnlyLoser)",
      async ({ winner, readOnlyLoser }) => {
        const fixture = await createFixture();
        const firstReady = createDeferred();
        const secondReady = createDeferred();
        const releaseFirst = createDeferred();
        const releaseSecond = createDeferred();
        const first = await fixture.createBackend("first", async (params, upload) => {
          await upload(params);
          if (path.basename(params.remoteDir) === "agent") {
            firstReady.resolve();
            await releaseFirst.promise;
          }
        });
        const second = await fixture.createBackend("second", async (params, upload) => {
          await upload(params);
          if (path.basename(params.remoteDir) === "agent") {
            if (readOnlyLoser) {
              await fixture.makeStageReadOnly(params.remoteDir);
            }
            secondReady.resolve();
            await releaseSecond.promise;
          }
        });
        const one = first.runShellCommand({ script: "true" });
        const two = second.runShellCommand({ script: "true" });
        try {
          await Promise.all([firstReady.promise, secondReady.promise]);
          releaseFirst.resolve();
          await one;
          const runtimeRoot = path.dirname(first.workdir);
          if (winner === "emptied") {
            await fs.rm(first.workdir, { recursive: true });
            await fs.rm(path.join(runtimeRoot, "agent"), { recursive: true });
          } else {
            await fs.writeFile(path.join(first.workdir, "full.txt"), "remote user edit");
          }
          releaseSecond.resolve();
          await two;
          if (winner === "emptied") {
            expect(await fs.readdir(runtimeRoot)).toEqual([]);
          } else {
            expect(await fs.readFile(path.join(first.workdir, "full.txt"), "utf8")).toBe(
              "remote user edit",
            );
            expect(await fs.readFile(path.join(runtimeRoot, "agent", "full.txt"), "utf8")).toBe(
              "first-agent",
            );
          }
          if (readOnlyLoser) {
            await fixture.assertProtectedUnchanged();
          }
          expect(await fs.readdir(fixture.remoteRoot)).toEqual([
            path.basename(path.dirname(first.workdir)),
          ]);
        } finally {
          releaseFirst.resolve();
          releaseSecond.resolve();
          await Promise.allSettled([one, two]);
          await fixture.restorePermissions();
        }
      },
    );

    it("adopts existing unmarked remote workspaces without reseeding them", async () => {
      const fixture = await createFixture();
      const backend = await fixture.createBackend("source");
      await fs.mkdir(backend.workdir, { recursive: true });
      await fs.writeFile(path.join(backend.workdir, "full.txt"), "existing remote edit");
      await backend.runShellCommand({ script: "true" });
      expect(await fs.readFile(path.join(backend.workdir, "full.txt"), "utf8")).toBe(
        "existing remote edit",
      );
      await expect(
        fs.stat(path.join(path.dirname(backend.workdir), "agent")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  },
);
