/** A candidate's native service stays inside the retained probe process owner. */
import fs from "node:fs/promises";
import path from "node:path";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import {
  closeOwnedStdioProcess,
  commandProcessCleanup,
  createOwnedStdioProcess,
  OwnedStdioCleanupError,
  runExec,
  type OwnedStdioProcess,
} from "openclaw/plugin-sdk/process-runtime";
import { sleepWithAbort } from "openclaw/plugin-sdk/retry-runtime";

export async function startCodexComputerUseProbeService(params: {
  appPath: string;
  home: string;
  signal: AbortSignal;
  assertCurrent: () => void;
}): Promise<{
  env: {
    SKY_CUA_SERVICE_NATIVE_PIPE_PATH: string;
    NODE_REPL_HOST_SERVICES_PIPE_PATH: string;
  };
  close: () => Promise<void>;
}> {
  params.assertCurrent();
  // Darwin's sockaddr_un is only 104 bytes. Configured state/temp homes can be
  // much longer; mkdtemp gives this bounded IPC-only directory private ownership.
  const ipcRoot = await fs.realpath(await fs.mkdtemp("/tmp/oc-cua-"));
  const env = {
    SKY_CUA_SERVICE_NATIVE_PIPE_PATH: path.join(ipcRoot, "native.sock"),
    // The SDK's host-service route fails closed if our service dies. It must not
    // fall back to LaunchServices, which detaches a replacement outside our tree.
    NODE_REPL_HOST_SERVICES_PIPE_PATH: path.join(ipcRoot, "no-autostart.sock"),
  };
  let child: OwnedStdioProcess | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      if (child) {
        try {
          await closeOwnedStdioProcess(child);
        } catch (cause) {
          throw new commandProcessCleanup.Error({
            cause: new Error(`Candidate native service IPC retained at ${ipcRoot}.`, { cause }),
          });
        }
      }
      await fs.rm(ipcRoot, { recursive: true, force: true });
    })());
  try {
    const info = await runExec(
      "/usr/bin/plutil",
      [
        "-extract",
        "CFBundleExecutable",
        "raw",
        "-o",
        "-",
        path.join(params.appPath, "Contents/Info.plist"),
      ],
      { timeoutMs: 30_000, logOutput: false },
    );
    const executable = info.stdout.trim();
    if (
      !executable ||
      executable === "." ||
      executable === ".." ||
      path.basename(executable) !== executable
    ) {
      throw new Error("Candidate native service has an invalid executable name.");
    }
    const serviceEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: params.home,
      CODEX_HOME: params.home,
      ...env,
    };
    for (const key of Object.keys(serviceEnv)) {
      if (/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/iu.test(key)) {
        delete serviceEnv[key];
      }
    }
    params.assertCurrent();
    child = await createOwnedStdioProcess({
      argv: [path.join(params.appPath, "Contents/MacOS", executable)],
      cwd: params.home,
      env: serviceEnv,
      exactEnv: true,
      abortSignal: params.signal,
    });
    let failure: Error | undefined;
    child.onExit((code, signal) => {
      failure = new Error(`Candidate native service exited (${signal ?? code}).`);
    });
    child.onError((error) => {
      failure = error;
    });
    child.onStdout(() => {});
    child.onStderr(() => {});
    const deadline = Date.now() + 30_000;
    for (;;) {
      params.assertCurrent();
      params.signal.throwIfAborted();
      if (failure) {
        throw failure;
      }
      const socket = await fs
        .lstat(env.SKY_CUA_SERVICE_NATIVE_PIPE_PATH)
        .catch((error: unknown) => {
          if (extractErrorCode(error) === "ENOENT") {
            return undefined;
          }
          throw error;
        });
      if (socket?.isSocket()) {
        break;
      }
      if (socket || Date.now() >= deadline) {
        throw new Error("Candidate native service did not expose its private IPC socket.");
      }
      await sleepWithAbort(50, params.signal);
    }
    params.assertCurrent();
    return { env, close };
  } catch (error) {
    if (error instanceof OwnedStdioCleanupError) {
      throw new commandProcessCleanup.Error({
        cause: new Error(`Candidate native service startup retained IPC at ${ipcRoot}.`, {
          cause: error,
        }),
      });
    }
    await close();
    throw error;
  }
}
