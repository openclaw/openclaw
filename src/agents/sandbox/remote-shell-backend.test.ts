import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { hasErrnoCode } from "../../infra/errno.js";
import { spawnCommand } from "../../process/exec.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { createRemoteShellSandboxBackend } from "./remote-shell-backend.js";
import {
  createRemoteShellSandboxSession,
  type RemoteShellSandboxSession,
} from "./remote-shell-transport.js";

type RemoteShellUploadParams = Parameters<RemoteShellSandboxSession["uploadDirectory"]>[0];

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function sandboxConfig(workspaceRoot: string, scope?: "session") {
  const sandbox = {
    mode: "all",
    backend: "ssh",
    scope,
    workspaceAccess: "rw",
    ssh: { target: "unused", workspaceRoot },
  } satisfies NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["sandbox"];
  return resolveSandboxConfigForAgent({ agents: { defaults: { sandbox } } }, "test");
}

const emptyResult = () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 });
const expectText = async (file: string, text: string) =>
  expect(await fs.readFile(file, "utf8")).toBe(text);
const run = (backend: Awaited<ReturnType<typeof createRemoteShellSandboxBackend>>) =>
  backend.runShellCommand({ script: "true" });
async function writeFile(file: string, text: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}
function createBackend(
  workspaceDir: string,
  createSession: () => Promise<RemoteShellSandboxSession>,
  options: Partial<Parameters<typeof createRemoteShellSandboxBackend>[0]> = {},
) {
  return createRemoteShellSandboxBackend(
    {
      cfg: sandboxConfig(path.join(workspaceDir, "remote")),
      scopeKey: "command-cancellation",
      sessionKey: "test",
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      skillsWorkspaceDir: workspaceDir,
      ...options,
    },
    { createSession },
  );
}

function barrier() {
  const entered = createDeferred();
  const release = createDeferred();
  return {
    entered: entered.promise,
    release: () => release.resolve(),
    wait: async () => {
      entered.resolve();
      await release.promise;
    },
  };
}

async function createCommandCancellationFixture() {
  const workspaceDir = tempDirs.make("remote-shell-cancellation-");
  const session = {
    runCommand: vi.fn<RemoteShellSandboxSession["runCommand"]>(async () => ({
      ...emptyResult(),
      stdout: Buffer.from("1\n"),
    })),
    uploadDirectory: vi.fn<RemoteShellSandboxSession["uploadDirectory"]>(async () => {}),
    prepareExec: async () => {
      throw new Error("unexpected exec preparation");
    },
    dispose: vi.fn(async () => {}),
  } satisfies RemoteShellSandboxSession;
  const createSession = vi.fn(async () => session);
  const backend = await createBackend(workspaceDir, createSession);
  await run(backend);
  session.runCommand.mockClear();
  session.uploadDirectory.mockClear();
  session.dispose.mockClear();
  createSession.mockClear();
  return { backend, session, createSession };
}

describe("remote shell command cancellation", () => {
  it.each(["acquire", "clear", "upload"] as const)(
    "cancels during %s and joins remote work and session disposal before rejecting",
    async (phase) => {
      const { backend, session, createSession } = await createCommandCancellationFixture();
      const controller = new AbortController();
      const work = barrier();
      const disposal = barrier();
      const onAbort = vi.fn();
      const onComplete = vi.fn();
      const hold = async (signal?: AbortSignal) => {
        signal?.addEventListener("abort", onAbort, { once: true });
        await work.wait();
        signal?.throwIfAborted();
      };
      if (phase === "acquire") {
        createSession.mockImplementationOnce(async () => {
          await work.wait();
          return session;
        });
      } else if (phase === "clear") {
        session.runCommand.mockImplementationOnce(async ({ signal }) => {
          await hold(signal);
          return emptyResult();
        });
      } else {
        session.uploadDirectory.mockImplementationOnce(({ signal }) => hold(signal));
      }
      session.dispose.mockImplementationOnce(disposal.wait);
      const result = backend
        .runShellCommand({ script: "touch sentinel", signal: controller.signal })
        .catch((error: unknown) => error)
        .finally(onComplete);
      try {
        await work.entered;
        controller.abort(new Error("interrupt deadline"));
        expect(onAbort).toHaveBeenCalledTimes(phase === "acquire" ? 0 : 1);
        expect(session.dispose).not.toHaveBeenCalled();
        expect(onComplete).not.toHaveBeenCalled();
        work.release();
        await disposal.entered;
        expect(onComplete).not.toHaveBeenCalled();
        disposal.release();
        expect(await result).toMatchObject({ message: "interrupt deadline" });
        expect(session.runCommand).toHaveBeenCalledTimes(phase === "acquire" ? 0 : 1);
        expect(session.uploadDirectory).toHaveBeenCalledTimes(phase === "upload" ? 1 : 0);
        expect(session.dispose).toHaveBeenCalledOnce();
      } finally {
        work.release();
        disposal.release();
        await result;
      }
    },
  );
});

async function createFixture() {
  const root = await fs.realpath(tempDirs.make("remote-shell-bootstrap-"));
  const remoteRoot = path.join(root, "remote");
  const partialDir = path.join(root, "partial");
  await writeFile(path.join(partialDir, "partial.txt"), "incomplete transfer");
  const cfg = sandboxConfig(remoteRoot, "session");
  const createTestBackend = async (
    label: string,
    upload?: (
      params: RemoteShellUploadParams,
      run: (params: RemoteShellUploadParams) => Promise<void>,
    ) => Promise<void>,
  ) => {
    const workspaceDir = path.join(root, label, "workspace");
    const agentWorkspaceDir = path.join(root, label, "agent");
    await writeFile(path.join(workspaceDir, "full.txt"), `${label}-primary`);
    await writeFile(path.join(agentWorkspaceDir, "full.txt"), `${label}-agent`);
    return createBackend(
      workspaceDir,
      async () => {
        const session = sessionFor(workspaceDir);
        return {
          ...session,
          uploadDirectory: (params) =>
            upload
              ? upload(params, (input) => session.uploadDirectory(input))
              : session.uploadDirectory(params),
        };
      },
      { cfg, scopeKey: "shared-scope", agentWorkspaceDir, skillsWorkspaceDir: undefined },
    );
  };
  const protectedDir = path.join(root, "protected");
  const restrictiveDirectories: string[] = [];
  const makeStageReadOnly = async (directory: string) => {
    const child = path.join(directory, "readonly");
    const nested = path.join(child, "nested");
    await writeFile(path.join(nested, "payload"), "readonly payload");
    await writeFile(path.join(protectedDir, "untouched"), "outside stage");
    await fs.chmod(protectedDir, 0o555);
    await fs.symlink(protectedDir, path.join(child, "outside"));
    restrictiveDirectories.push(directory, child, nested);
    for (const dir of [nested, child, directory]) {
      await fs.chmod(dir, 0o400);
    }
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
    await expectText(path.join(protectedDir, "untouched"), "outside stage");
  };
  const pausedBackend = (label: string, pause: ReturnType<typeof barrier>, readOnly = false) =>
    createTestBackend(label, async (params, upload) => {
      await upload(params);
      if (path.basename(params.remoteDir) === "agent") {
        if (readOnly) {
          await makeStageReadOnly(params.remoteDir);
        }
        await pause.wait();
      }
    });
  return {
    remoteRoot,
    partialDir,
    createBackend: createTestBackend,
    pausedBackend,
    makeStageReadOnly,
    restorePermissions,
    assertProtectedUnchanged,
  };
}

describe.runIf(process.platform === "linux" || process.platform === "darwin")(
  "remote workspace initialization",
  () => {
    it.each(["workspace", "agent"])(
      "retries incomplete %s uploads without publishing a partial workspace",
      async (interrupted) => {
        const readOnly = interrupted === "agent";
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
          await expect(run(backend)).rejects.toThrow("interrupted initial upload");
          await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
          expect(await fs.readdir(fixture.remoteRoot)).toEqual([]);
          if (readOnly) {
            await fixture.assertProtectedUnchanged();
          }
          await run(backend);
          await expectText(path.join(backend.workdir, "full.txt"), "source-primary");
          await expectText(path.join(root, "agent", "full.txt"), "source-agent");
          expect(await fs.readdir(backend.workdir)).toEqual(["full.txt"]);
          expect(await fs.readdir(fixture.remoteRoot)).toEqual([path.basename(root)]);
        } finally {
          await fixture.restorePermissions();
        }
      },
    );

    it.each(["emptied", "edited"])(
      "keeps a concurrently published %s workspace",
      async (winner) => {
        const readOnlyLoser = winner === "edited";
        const fixture = await createFixture();
        const firstGate = barrier();
        const secondGate = barrier();
        const first = await fixture.pausedBackend("first", firstGate);
        const second = await fixture.pausedBackend("second", secondGate, readOnlyLoser);
        const one = run(first);
        const two = run(second);
        try {
          await Promise.all([firstGate.entered, secondGate.entered]);
          firstGate.release();
          await one;
          const runtimeRoot = path.dirname(first.workdir);
          if (winner === "emptied") {
            await fs.rm(first.workdir, { recursive: true });
            await fs.rm(path.join(runtimeRoot, "agent"), { recursive: true });
          } else {
            await fs.writeFile(path.join(first.workdir, "full.txt"), "remote user edit");
          }
          secondGate.release();
          await two;
          if (winner === "emptied") {
            expect(await fs.readdir(runtimeRoot)).toEqual([]);
          } else {
            await expectText(path.join(first.workdir, "full.txt"), "remote user edit");
            await expectText(path.join(runtimeRoot, "agent", "full.txt"), "first-agent");
          }
          if (readOnlyLoser) {
            await fixture.assertProtectedUnchanged();
          }
          expect(await fs.readdir(fixture.remoteRoot)).toEqual([path.basename(runtimeRoot)]);
        } finally {
          firstGate.release();
          secondGate.release();
          await Promise.allSettled([one, two]);
          await fixture.restorePermissions();
        }
      },
    );

    it("validates real workspace and agent directories without creating missing paths", async () => {
      const fixture = await createFixture();
      const backend = await fixture.createBackend("source one");
      await run(backend);
      for (const root of [backend.workdir, path.join(path.dirname(backend.workdir), "agent")]) {
        const workdir = path.join(root, "src");
        await fs.mkdir(workdir);
        await expect(backend.validateWorkdir?.(workdir)).resolves.toBe(await fs.realpath(workdir));
      }
      const missing = path.join(backend.workdir, "missing");
      await expect(backend.validateWorkdir?.(missing)).resolves.toBeNull();
      await expect(fs.stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("adopts existing unmarked remote workspaces without reseeding them", async () => {
      const fixture = await createFixture();
      const backend = await fixture.createBackend("source");
      await writeFile(path.join(backend.workdir, "full.txt"), "existing remote edit");
      await run(backend);
      await expectText(path.join(backend.workdir, "full.txt"), "existing remote edit");
      await expect(
        fs.stat(path.join(path.dirname(backend.workdir), "agent")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  },
);

const sessionFor = (
  root: string,
  argv = (command: string) => ["/bin/sh", "-c", command],
  env = process.env,
) =>
  createRemoteShellSandboxSession({
    buildCommand: ({ remoteCommand }) => ({ argv: argv(remoteCommand), env, cwd: root }),
  });

async function uploadFixture(prefix: string, payload: string | Buffer) {
  const root = await fs.realpath(tempDirs.make(prefix));
  const localDir = path.join(root, "local");
  const remoteDir = path.join(root, "remote");
  await fs.mkdir(localDir);
  await fs.writeFile(path.join(localDir, "payload"), payload);
  return { root, localDir, remoteDir, remoteRootDir: root };
}

describe.runIf(process.platform !== "win32")("provider-owned remote shell transport", () => {
  it("keeps uploads, private exec staging, execution, and cleanup behind the command owner", async () => {
    const payload = Buffer.from([0, 1, 2, 255]);
    const upload = await uploadFixture("remote-shell-owner-", payload);
    const { root, localDir, remoteDir } = upload;
    const claimFile = path.join(root, "claim");
    const providerFile = path.join(root, "provider.cjs");
    await fs.writeFile(claimFile, "original");
    await fs.writeFile(
      providerFile,
      `
      const fs = require("node:fs");
      const { spawnSync } = require("node:child_process");
      if (fs.readFileSync(${JSON.stringify(claimFile)}, "utf8") !== "original") {
        process.stderr.write("provider owner changed");
        process.exit(42);
      }
      if (process.env.PROVIDER_LOCAL_ONLY !== "synthetic-provider-auth") process.exit(43);
      const child = spawnSync("/bin/sh", ["-c", process.argv[2]], {
        stdio: "inherit", env: { PATH: process.env.PATH },
      });
      process.exit(child.status ?? 1);
    `,
    );
    const session = sessionFor(root, (command) => [process.execPath, providerFile, command], {
      ...process.env,
      PROVIDER_LOCAL_ONLY: "synthetic-provider-auth",
    });
    await session.uploadDirectory(upload);
    expect(await fs.readFile(path.join(remoteDir, "payload"))).toEqual(payload);

    const prepared = await session.prepareExec({
      remoteCommand: 'printf "%s:%s" "$EXEC_PRIVATE" "${PROVIDER_LOCAL_ONLY-unset}"',
      env: { EXEC_PRIVATE: "synthetic-exec-private" },
    });
    try {
      expect(prepared.argv.join(" ")).not.toContain("synthetic-exec-private");
      expect(prepared.cwd).toBe(root);
      await fs.writeFile(claimFile, "transferred");
      const execute = (reject = true) =>
        spawnCommand(prepared.argv, {
          baseEnv: prepared.env,
          cwd: prepared.cwd,
          reject,
        });
      const refused = await execute(false);
      expect(refused).toMatchObject({ exitCode: 42, stdout: "" });
      await fs.writeFile(path.join(localDir, "payload"), "changed after claim transfer");
      await expect(session.uploadDirectory(upload)).rejects.toThrow();
      expect(await fs.readFile(path.join(remoteDir, "payload"))).toEqual(payload);
      await fs.writeFile(claimFile, "original");
      await expect(execute()).resolves.toMatchObject({ stdout: "synthetic-exec-private:unset" });
    } finally {
      await fs.writeFile(claimFile, "original");
      await prepared.cleanup();
      await session.dispose();
    }
  });

  it("rejects an upload when the remote shell dies from a signal without a status", async () => {
    const upload = await uploadFixture("remote-shell-signal-", "payload-bytes");
    const session = sessionFor(upload.root, () => [
      "/bin/sh",
      "-c",
      'cat >/dev/null; kill -TERM "$$"',
    ]);
    await expect(session.uploadDirectory(upload)).rejects.toThrow(
      "remote exited from signal SIGTERM",
    );
    await session.dispose();
  });
});
