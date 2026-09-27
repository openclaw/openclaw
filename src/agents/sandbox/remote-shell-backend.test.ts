import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

async function createCommandCancellationFixture() {
  const workspaceDir = tempDirs.make("remote-shell-cancellation-");
  const session = {
    runCommand: vi.fn<RemoteShellSandboxSession["runCommand"]>(async () => ({
      stdout: Buffer.from("1\n"),
      stderr: Buffer.alloc(0),
      code: 0,
    })),
    uploadDirectory: vi.fn<RemoteShellSandboxSession["uploadDirectory"]>(async () => {}),
    prepareExec: async () => {
      throw new Error("unexpected exec preparation");
    },
    dispose: vi.fn(async () => {}),
  } satisfies RemoteShellSandboxSession;
  const createSession = vi.fn(async () => session);
  const backend = await createRemoteShellSandboxBackend(
    {
      cfg: resolveSandboxConfigForAgent({
        agents: {
          defaults: {
            sandbox: {
              mode: "all",
              backend: "ssh",
              workspaceAccess: "rw",
              ssh: { target: "unused", workspaceRoot: path.join(workspaceDir, "remote") },
            },
          },
        },
      }),
      scopeKey: "command-cancellation",
      sessionKey: "test",
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      skillsWorkspaceDir: workspaceDir,
    },
    { createSession },
  );
  await backend.runShellCommand({ script: "true" });
  session.runCommand.mockClear();
  session.uploadDirectory.mockClear();
  session.dispose.mockClear();
  createSession.mockClear();
  return { backend, session, createSession };
}

describe("remote shell command cancellation", () => {
  it.each(["clear", "upload"] as const)(
    "cancels the skills %s and joins it and session disposal before rejecting",
    async (phase) => {
      const { backend, session } = await createCommandCancellationFixture();
      const controller = new AbortController();
      const entered = createDeferred();
      const release = createDeferred();
      const disposing = createDeferred();
      const releaseDisposal = createDeferred();
      let cancellationObserved = false;
      let completed = false;
      const hold = async (signal?: AbortSignal) => {
        signal?.addEventListener(
          "abort",
          () => {
            cancellationObserved = true;
          },
          { once: true },
        );
        entered.resolve();
        await release.promise;
        signal?.throwIfAborted();
      };
      if (phase === "clear") {
        session.runCommand.mockImplementationOnce(async ({ signal }) => {
          await hold(signal);
          return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 };
        });
      } else {
        session.uploadDirectory.mockImplementationOnce(({ signal }) => hold(signal));
      }
      session.dispose.mockImplementationOnce(async () => {
        disposing.resolve();
        await releaseDisposal.promise;
      });
      const command = backend.runShellCommand({
        script: "touch sentinel",
        signal: controller.signal,
      });
      const result = command.then(
        () => {
          completed = true;
          return undefined;
        },
        (error: unknown) => {
          completed = true;
          return error;
        },
      );
      try {
        await entered.promise;
        controller.abort(new Error("interrupt deadline"));
        expect(cancellationObserved).toBe(true);
        expect(session.dispose).not.toHaveBeenCalled();
        expect(completed).toBe(false);
        release.resolve();
        await disposing.promise;
        expect(completed).toBe(false);
        releaseDisposal.resolve();
        expect(await result).toEqual(expect.objectContaining({ message: "interrupt deadline" }));
        expect(session.runCommand).toHaveBeenCalledOnce();
        expect(session.uploadDirectory).toHaveBeenCalledTimes(phase === "upload" ? 1 : 0);
        expect(session.dispose).toHaveBeenCalledOnce();
      } finally {
        release.resolve();
        releaseDisposal.resolve();
        await result;
      }
    },
  );

  it("disposes a session acquired after cancellation without starting remote work", async () => {
    const { backend, session, createSession } = await createCommandCancellationFixture();
    const entered = createDeferred();
    const release = createDeferred();
    const controller = new AbortController();
    createSession.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return session;
    });
    const command = backend.runShellCommand({
      script: "touch sentinel",
      signal: controller.signal,
    });
    const result = command.then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await entered.promise;
      controller.abort(new Error("interrupt deadline"));
      release.resolve();
      expect(await result).toEqual(expect.objectContaining({ message: "interrupt deadline" }));
      expect(session.runCommand).not.toHaveBeenCalled();
      expect(session.uploadDirectory).not.toHaveBeenCalled();
      expect(session.dispose).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await result;
    }
  });
});

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
