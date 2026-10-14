import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { HealthCheck, HealthFinding } from "openclaw/plugin-sdk/health";
import {
  CODEX_VERSION_TIMEOUT_MS,
  parseCodexVersion,
  resolveManagedCodexNativeCommand,
  runCodexVersionCommand,
} from "./app-server/managed-binary.js";
import { describeCodexSpawnError, findCodexAppServerSpawnError } from "./app-server/spawn-error.js";
import { CODEX_APP_SERVER_VERSION } from "./app-server/version.js";
import {
  resolveCodexDoctorStartOptions,
  type CodexDoctorStartOptionsDependencies,
} from "./doctor-start-options.js";

export const CODEX_MANAGED_APP_SERVER_CHECK_ID = "codex/managed-app-server";

type CodexManagedDoctorDependencies = CodexDoctorStartOptionsDependencies & {
  resolveNativeCommand?: typeof resolveManagedCodexNativeCommand;
  /** Returns combined stdout and stderr. */
  runVersionCommand?: (command: string) => Promise<string>;
};

type CodexManagedDoctorRegistrationHost = {
  readonly getHealthCheck: (id: string) => HealthCheck | undefined;
  readonly registerHealthCheck: (check: HealthCheck) => void;
  readonly pluginRoot: string;
};

function managedCodexFindings(params: {
  message: string;
  severity?: HealthFinding["severity"];
  path?: string;
  requirement?: string;
  fixHint?: string;
}): HealthFinding[] {
  return [
    {
      checkId: CODEX_MANAGED_APP_SERVER_CHECK_ID,
      severity: params.severity ?? "error",
      source: "codex",
      message: params.message,
      ...(params.path ? { path: params.path } : {}),
      ...(params.requirement ? { requirement: params.requirement } : {}),
      ...(params.fixHint ? { fixHint: params.fixHint } : {}),
    },
  ];
}

function createCodexManagedAppServerHealthCheck(params: {
  pluginRoot: string;
  deps?: CodexManagedDoctorDependencies;
}): HealthCheck & { readonly defaultEnabled: false } {
  const resolveNativeCommand =
    params.deps?.resolveNativeCommand ?? resolveManagedCodexNativeCommand;

  return {
    id: CODEX_MANAGED_APP_SERVER_CHECK_ID,
    kind: "plugin",
    description: "Verify the shipped managed Codex app-server binary and pinned version.",
    source: "codex",
    defaultEnabled: false,
    async detect(ctx) {
      const env = ctx.env ?? process.env;
      const isFinalization = ctx.mode === "fix" && env.OPENCLAW_UPDATE_POST_CORE === "1";
      const versionFailureSeverity = isFinalization ? "warning" : "error";
      const versionFailureHint = isFinalization
        ? "Codex readiness will be rechecked by its plugin after restart; inspect the Codex plugin if the warning persists."
        : undefined;
      let selection;
      try {
        selection = await resolveCodexDoctorStartOptions({
          cfg: ctx.cfg,
          env,
          pluginRoot: params.pluginRoot,
          managedOnly: true,
          deps: params.deps,
        });
      } catch (error) {
        return managedCodexFindings({
          message: `Managed Codex app-server could not be resolved: ${coerceErrorMessage(error)}`,
          path: params.pluginRoot,
          requirement: `an executable Codex ${CODEX_APP_SERVER_VERSION} managed artifact`,
          fixHint:
            "Reinstall the staged OpenClaw package with its @openai/codex platform dependency, then rerun the candidate check.",
        });
      }
      if (selection.status === "skipped") {
        return [];
      }
      const resolved = selection.start;

      const nativeCommand = resolveNativeCommand(resolved.command);
      if (!nativeCommand) {
        return managedCodexFindings({
          message: "Managed Codex app-server resolved a launcher without a native artifact.",
          path: resolved.command,
          requirement: `the platform-native Codex ${CODEX_APP_SERVER_VERSION} executable`,
          fixHint:
            "Reinstall the staged OpenClaw package with the matching @openai/codex platform package, then rerun the candidate check.",
        });
      }

      let output: string;
      try {
        output = await (params.deps?.runVersionCommand
          ? params.deps.runVersionCommand(nativeCommand)
          : runCodexVersionCommand(nativeCommand, env));
      } catch (error) {
        const spawnFailure = findCodexAppServerSpawnError(
          describeCodexSpawnError(error, nativeCommand),
        );
        return managedCodexFindings({
          message:
            spawnFailure?.message ??
            `Managed Codex app-server version check failed: ${coerceErrorMessage(error)}`,
          severity:
            spawnFailure && resolved.managedCommandOrder === "package-only"
              ? "warning"
              : versionFailureSeverity,
          path: nativeCommand,
          requirement: `Codex ${CODEX_APP_SERVER_VERSION} must report its version within ${CODEX_VERSION_TIMEOUT_MS} ms`,
          fixHint:
            versionFailureHint ??
            "Repair or reinstall the staged OpenClaw package, then rerun the candidate check before cutover.",
        });
      }

      const detectedVersion = parseCodexVersion(output);
      if (detectedVersion !== CODEX_APP_SERVER_VERSION) {
        return managedCodexFindings({
          severity: versionFailureSeverity,
          message: detectedVersion
            ? `Managed Codex app-server version mismatch: expected ${CODEX_APP_SERVER_VERSION}, detected ${detectedVersion}.`
            : `Managed Codex app-server did not report a parseable version; expected ${CODEX_APP_SERVER_VERSION}.`,
          path: nativeCommand,
          requirement: `the exact OpenClaw-pinned Codex version ${CODEX_APP_SERVER_VERSION}`,
          fixHint:
            versionFailureHint ??
            "Reinstall the staged OpenClaw package so its managed @openai/codex dependency matches the pinned version, then rerun the candidate check.",
        });
      }
      return [];
    },
  };
}

export function registerCodexManagedAppServerDoctorChecks(
  host: CodexManagedDoctorRegistrationHost,
  deps?: CodexManagedDoctorDependencies,
): void {
  // Lookup and registration must use the same host registry across artifact loaders.
  if (host.getHealthCheck(CODEX_MANAGED_APP_SERVER_CHECK_ID)) {
    return;
  }
  host.registerHealthCheck(
    createCodexManagedAppServerHealthCheck({ pluginRoot: host.pluginRoot, deps }),
  );
}
