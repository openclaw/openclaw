import { resolve } from "node:path";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";

export type FaceTimeDriverStatus = "current" | "invalid" | "missing" | "outdated";

type DriverSetupParams = {
  pluginRoot: string;
  runCommandWithTimeout: PluginRuntime["system"]["runCommandWithTimeout"];
  signal?: AbortSignal;
};

function readDriverStatus(output: string): FaceTimeDriverStatus {
  const status = output.trim();
  if (
    status === "current" ||
    status === "invalid" ||
    status === "missing" ||
    status === "outdated"
  ) {
    return status;
  }
  throw new Error(`Unexpected FaceTime driver status: ${status || "(empty)"}`);
}

export async function inspectFaceTimeDriver(
  params: DriverSetupParams,
): Promise<FaceTimeDriverStatus> {
  const script = resolve(params.pluginRoot, "scripts", "install-driver.sh");
  const result = await params.runCommandWithTimeout(["/bin/sh", script, "--status"], {
    timeoutMs: 10_000,
  });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `driver status exited ${result.code}`);
  }
  return readDriverStatus(result.stdout);
}

async function runDriverSetup(params: DriverSetupParams, action: "ensure" | "uninstall") {
  const script = resolve(params.pluginRoot, "scripts", "install-driver.sh");
  const result = await params.runCommandWithTimeout(["/bin/sh", script, `--${action}`], {
    // The macOS administrator sheet can legitimately remain open while the
    // operator is away. Runtime shutdown aborts the whole process tree instead.
    killProcessTree: true,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (result.code !== 0) {
    const label = action === "ensure" ? "audio driver installation" : "uninstall";
    throw new Error(
      `FaceTime ${label} failed: ${result.stderr || result.stdout || `exit ${result.code}`}`,
    );
  }
}

export async function installFaceTimeDriver(
  params: DriverSetupParams,
): Promise<{ changed: boolean; status: "current" }> {
  const before = await inspectFaceTimeDriver(params);
  if (before === "current") {
    return { changed: false, status: "current" };
  }
  await runDriverSetup(params, "ensure");
  return { changed: true, status: "current" };
}

export async function uninstallFaceTimeDriver(params: DriverSetupParams): Promise<void> {
  await runDriverSetup(params, "uninstall");
}
