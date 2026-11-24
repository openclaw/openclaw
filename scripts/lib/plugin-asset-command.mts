// Keep asset deadlines and child cleanup identical across root and isolated builds.
import { runManagedCommand } from "./managed-child-process.mts";

const PLUGIN_ASSET_HOOK_TIMEOUT_MS = 600_000;

export async function runPluginAssetCommand(params: {
  command: string;
  cwd: string;
  pluginId: string;
  phase: "build" | "copy";
}): Promise<number> {
  // The hook builds the package's own source tree. Release tooling pins
  // TSX_TSCONFIG_PATH to its trusted checkout; inheriting it would map the
  // packed tree's workspace imports onto the tooling's packages instead.
  const { TSX_TSCONFIG_PATH: _toolingTsconfig, ...env } = process.env;
  try {
    return await runManagedCommand({
      bin: params.command,
      cwd: params.cwd,
      env,
      shell: true,
      stdio: "inherit",
      timeoutMs: PLUGIN_ASSET_HOOK_TIMEOUT_MS,
      requireProcessTreeExit: process.platform !== "win32",
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ETIMEDOUT") {
      throw Object.assign(
        new Error(
          `Plugin asset ${params.phase} hook timed out after ${PLUGIN_ASSET_HOOK_TIMEOUT_MS}ms: ${params.pluginId}`,
          { cause: error },
        ),
        { code: "ETIMEDOUT" },
      );
    }
    throw error;
  }
}
