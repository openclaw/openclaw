import path from "node:path";
import { fileURLToPath } from "node:url";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { HealthCheck, OpenClawConfig } from "openclaw/plugin-sdk/health";
import { codexNativeProfileRecoveryHealthCheck } from "./src/auth-profile-health.js";
import {
  CODEX_MANAGED_APP_SERVER_CHECK_ID,
  registerCodexManagedAppServerDoctorChecks as registerChecks,
} from "./src/doctor.js";
import type { CodexWorkspaceWriteSandboxProbe } from "./src/workspace-write-sandbox-probe.js";

const CODEX_PLUGIN_ROOT = path.dirname(fileURLToPath(import.meta.url));

export { CODEX_MANAGED_APP_SERVER_CHECK_ID };
export type { CodexWorkspaceWriteSandboxProbe };

export async function probeCodexWorkspaceWriteSandbox(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<CodexWorkspaceWriteSandboxProbe> {
  try {
    const { probeCodexWorkspaceWriteSandbox: probe } =
      await import("./src/workspace-write-sandbox-probe.js");
    return await probe({ ...params, pluginRoot: CODEX_PLUGIN_ROOT });
  } catch (error) {
    return { status: "inconclusive", reason: coerceErrorMessage(error) };
  }
}

export function registerCodexManagedAppServerDoctorChecks(host: {
  getHealthCheck(id: string): HealthCheck | undefined;
  registerHealthCheck(check: HealthCheck): void;
}): void {
  registerChecks({ ...host, pluginRoot: CODEX_PLUGIN_ROOT });
  if (!host.getHealthCheck(codexNativeProfileRecoveryHealthCheck.id)) {
    host.registerHealthCheck(codexNativeProfileRecoveryHealthCheck);
  }
}
