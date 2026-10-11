import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  buildRemoteWorkdirValidationCommand,
  buildValidatedExecRemoteCommand,
  createRemoteShellSandboxFsBridge,
  shellEscape,
  type CreateReservedSandboxBackendParamsV1,
  type SandboxBackendCommandParams,
  type SandboxBackendHandle,
  type SandboxBackendManager,
} from "openclaw/plugin-sdk/sandbox";
import type { CloudRunConfig } from "./config.js";
import { resolveMounts, validateRootfs } from "./filesystem.js";
import { assertRecord, GuestOwner, type Guest } from "./guest.js";

export const BACKEND_ID = "cloud-run-sandbox";
export const reserveRuntimeId = () => "oc-cr-" + randomUUID();
const GUEST_PATH = "/usr/local/bin:/usr/bin:/bin";

export async function createBackend(
  params: CreateReservedSandboxBackendParamsV1,
  config: CloudRunConfig,
  owner: GuestOwner,
  stateDir: string,
): Promise<SandboxBackendHandle> {
  params.assertRuntimeCurrent();
  if (process.platform !== "linux" || process.getuid?.() !== 0) {
    throw new Error(
      "Cloud Run workspace mounts currently require a dedicated root launcher environment; the standard non-root OpenClaw image is unchanged",
    );
  }
  const rootfs = await validateRootfs(config.rootfs, stateDir);
  params.assertRuntimeCurrent();
  const mounts = await resolveMounts(params, rootfs);
  const prepared = new WeakMap<Record<string, string>, Guest>();
  const tokens = new WeakMap<object, Guest>();
  const roots = [...new Set(mounts.map((mount) => mount.containerPath))];
  const rootFor = (workdir: string) =>
    roots
      .toSorted((a, b) => b.length - a.length)
      .find((root) => workdir === root || workdir.startsWith(root + "/"));
  const validation = (workdir: string) => {
    const root = rootFor(workdir);
    if (!root || !path.posix.isAbsolute(workdir) || path.posix.normalize(workdir) !== workdir) {
      throw new Error("Cloud Run workdir must stay inside a selected workspace mount");
    }
    return buildRemoteWorkdirValidationCommand({ workdir, root });
  };
  const newGuest = () => owner.guest(params.runtimeId, params.assertRuntimeCurrent);
  const runShellCommand = async (command: SandboxBackendCommandParams) => {
    params.assertRuntimeCurrent();
    command.signal?.throwIfAborted();
    const guest = newGuest();
    let cancellation: Promise<void> | undefined;
    const abort = () => {
      cancellation = guest.close();
      // The owning finally below observes and propagates cleanup failure.
      void cancellation.catch(() => undefined);
    };
    command.signal?.addEventListener("abort", abort, { once: true });
    try {
      await guest.create(config, rootfs, mounts);
      command.signal?.throwIfAborted();
      const result = await guest.exec(
        [
          "/usr/bin/env",
          "-i",
          "PATH=" + GUEST_PATH,
          "/bin/sh",
          "-c",
          command.script,
          "openclaw-shell",
          ...(command.args ?? []),
        ],
        { stdin: command.stdin, signal: command.signal },
      );
      command.signal?.throwIfAborted();
      if (result.code && !command.allowFailure) {
        throw Object.assign(
          new Error("Cloud Run command failed: " + result.stderr.toString("utf8").slice(-2000)),
          { code: result.code },
        );
      }
      return result;
    } finally {
      command.signal?.removeEventListener("abort", abort);
      await (cancellation ?? guest.close());
    }
  };
  const backend: SandboxBackendHandle = {
    id: BACKEND_ID,
    runtimeId: params.runtimeId,
    runtimeLabel: params.runtimeId,
    workdir: "/workspace",
    workdirValidation: "backend",
    workdirRoots: roots,
    env: params.cfg.docker.env,
    configLabel: rootfs,
    configLabelKind: "Guest rootfs",
    capabilities: { browser: false, readOnlyResourceMounts: true },
    async validateWorkdir(workdir) {
      if (!rootFor(workdir) || path.posix.normalize(workdir) !== workdir) {
        return null;
      }
      const result = await runShellCommand({ script: validation(workdir), allowFailure: true });
      return result.code === 0 ? result.stdout.toString("utf8").trim() : null;
    },
    prepareProcessCleanup(env) {
      params.assertRuntimeCurrent();
      const scopedEnv = { ...env };
      const guest = newGuest();
      // Identity is process-local custody, never an agent-supplied environment token.
      prepared.set(scopedEnv, guest);
      return {
        env: scopedEnv,
        terminate: () => guest.close(),
        interrupt: async () => {
          await guest.close();
          return true;
        },
      };
    },
    async buildExecSpec({ command, workdir = "/workspace", env, usePty }) {
      const guest = prepared.get(env) ?? newGuest();
      prepared.delete(env);
      try {
        if (usePty) {
          throw new Error("Cloud Run sandbox does not support PTY execution");
        }
        const validate = validation(workdir);
        const remote = buildValidatedExecRemoteCommand({ command, workdir, env: {} });
        const explicitEnv = {
          PATH: GUEST_PATH,
          ...env,
        };
        for (const [key, value] of Object.entries(explicitEnv)) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes("\0")) {
            throw new Error("Invalid Cloud Run guest environment");
          }
        }
        const script = [
          "set -e",
          ...Object.entries(explicitEnv).map(
            ([key, value]) => "export " + key + "=" + shellEscape(value),
          ),
          validate + " >/dev/null",
          "exec " + remote,
        ].join("\n");
        await guest.create(config, rootfs, mounts);
        const staged = await guest.exec(
          ["/bin/sh", "-c", "umask 077; cat > /tmp/openclaw-exec.sh"],
          { stdin: script, signal: AbortSignal.timeout(30_000) },
        );
        if (staged.code) {
          throw new Error("Cloud Run could not stage execution");
        }
        guest.assertCurrent();
        const token = {};
        tokens.set(token, guest);
        return {
          ...guest.execSpec(["/usr/bin/env", "-i", "/bin/sh", "/tmp/openclaw-exec.sh"]),
          stdinMode: "pipe-open",
          finalizeToken: token,
        };
      } catch (error) {
        try {
          await guest.close();
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Cloud Run preparation and cleanup failed",
            { cause: cleanupError },
          );
        }
        throw error;
      }
    },
    async finalizeExec({ token }) {
      if (!token || typeof token !== "object") {
        return;
      }
      const guest = tokens.get(token);
      if (!guest) {
        return;
      }
      await guest.close();
      tokens.delete(token);
    },
    runShellCommand,
    createFsBridge: ({ sandbox }) =>
      createRemoteShellSandboxFsBridge({
        sandbox,
        runtime: {
          remoteWorkspaceDir: "/workspace",
          remoteAgentWorkspaceDir: "/agent",
          runRemoteShellScript: runShellCommand,
        },
      }),
  };
  return backend;
}

export function createManager(owner: GuestOwner, config: CloudRunConfig): SandboxBackendManager {
  return {
    async describeRuntime({ entry }) {
      for (const { value } of await owner.journal.entries()) {
        assertRecord(value);
        if (value.runtimeId !== entry.containerName) {
          continue;
        }
        // There is no read-only inspect command. Even /bin/true is guest-owned
        // on the writable overlay, so executing it is not a safe status probe.
        throw new Error(
          "Cloud Run does not expose read-only runtime status for recorded guests; runtime listing is unavailable until they finish or cleanup completes",
        );
      }
      return {
        running: false,
        actualConfigLabel: config.rootfs,
        configLabelMatch: entry.image === config.rootfs,
      };
    },
    removeRuntime: ({ entry }) => owner.removeRuntime(entry.containerName),
  };
}
