import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { HealthCheck, HealthFinding } from "openclaw/plugin-sdk/health";
import { runUtf8CommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import {
  readManagedCodexExpectedVersion,
  resolveManagedCodexNativeCommand,
} from "./app-server/managed-binary.js";
import { describeCodexSpawnError, findCodexAppServerSpawnError } from "./app-server/spawn-error.js";
import { CODEX_APP_SERVER_VERSION } from "./app-server/version.js";
import {
  resolveCodexDoctorStartOptions,
  type CodexDoctorStartOptionsDependencies,
} from "./doctor-start-options.js";

export const CODEX_MANAGED_APP_SERVER_CHECK_ID = "codex/managed-app-server";
const CODEX_VERSION_TIMEOUT_MS = 5_000;
const CODEX_VERSION_MAX_BUFFER_BYTES = 64 * 1024;

type VersionCommandResult = {
  stdout: string;
  stderr: string;
};

type CodexManagedDoctorDependencies = CodexDoctorStartOptionsDependencies & {
  resolveNativeCommand?: typeof resolveManagedCodexNativeCommand;
  runVersionCommand?: (command: string) => Promise<VersionCommandResult>;
};

type CodexManagedDoctorRegistrationHost = {
  readonly getHealthCheck: (id: string) => HealthCheck | undefined;
  readonly registerHealthCheck: (check: HealthCheck) => void;
  readonly pluginRoot: string;
};

function managedCodexFinding(params: {
  message: string;
  severity?: HealthFinding["severity"];
  path?: string;
  requirement?: string;
  fixHint?: string;
}): HealthFinding {
  return {
    checkId: CODEX_MANAGED_APP_SERVER_CHECK_ID,
    severity: params.severity ?? "error",
    source: "codex",
    message: params.message,
    ...(params.path ? { path: params.path } : {}),
    ...(params.requirement ? { requirement: params.requirement } : {}),
    ...(params.fixHint ? { fixHint: params.fixHint } : {}),
  };
}

function parseCodexVersion(output: string): string | undefined {
  return /(?:^|\s)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?:\s|$)/u.exec(
    output,
  )?.[1];
}

async function runVersionCommand(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<VersionCommandResult> {
  const result = await runUtf8CommandWithTimeout([command, "--version"], {
    baseEnv: env,
    input: "",
    timeoutMs: CODEX_VERSION_TIMEOUT_MS,
    maxOutputBytes: CODEX_VERSION_MAX_BUFFER_BYTES,
    outputCapture: "head",
    terminateOnOutputLimit: true,
    killProcessTree: true,
    killSignal: "SIGKILL",
    killGraceMs: 0,
  });
  if (result.termination !== "exit" || result.code !== 0 || result.outputLimitExceeded) {
    throw new Error(
      result.outputLimitExceeded
        ? "Version output exceeded its capture limit"
        : result.termination === "timeout"
          ? `Version probe timed out after ${CODEX_VERSION_TIMEOUT_MS} ms`
          : `Version probe failed (${result.signal ?? result.code ?? result.termination})`,
    );
  }
  return result;
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
    description: "Verify the selected managed Codex app-server binary and selected version.",
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
      let expectedVersion: string = CODEX_APP_SERVER_VERSION;
      try {
        selection = await resolveCodexDoctorStartOptions({
          cfg: ctx.cfg,
          env,
          pluginRoot: params.pluginRoot,
          managedOnly: true,
          deps: params.deps,
        });
        if (selection.status === "selected") {
          expectedVersion = await readManagedCodexExpectedVersion(selection.start.command);
        }
      } catch (error) {
        return [
          managedCodexFinding({
            message: `Managed Codex app-server could not be resolved: ${coerceErrorMessage(error)}`,
            path: params.pluginRoot,
            requirement: `an executable Codex ${expectedVersion} managed artifact`,
            fixHint:
              "Reinstall the staged OpenClaw package with its @openai/codex platform dependency, then rerun the candidate check.",
          }),
        ];
      }
      if (selection.status === "skipped") {
        return [];
      }
      const resolved = selection.start;

      const nativeCommand = resolveNativeCommand(resolved.command);
      if (!nativeCommand) {
        return [
          managedCodexFinding({
            message: "Managed Codex app-server resolved a launcher without a native artifact.",
            path: resolved.command,
            requirement: `the platform-native Codex ${expectedVersion} executable`,
            fixHint:
              "Reinstall the staged OpenClaw package with the matching @openai/codex platform package, then rerun the candidate check.",
          }),
        ];
      }

      let output: VersionCommandResult;
      try {
        output = await (params.deps?.runVersionCommand
          ? params.deps.runVersionCommand(nativeCommand)
          : runVersionCommand(nativeCommand, env));
      } catch (error) {
        const spawnFailure = findCodexAppServerSpawnError(
          describeCodexSpawnError(error, nativeCommand),
        );
        return [
          managedCodexFinding({
            message:
              spawnFailure?.message ??
              `Managed Codex app-server version check failed: ${coerceErrorMessage(error)}`,
            severity:
              spawnFailure && resolved.managedCommandOrder === "package-only"
                ? "warning"
                : versionFailureSeverity,
            path: nativeCommand,
            requirement: `Codex ${expectedVersion} must report its version within ${CODEX_VERSION_TIMEOUT_MS} ms`,
            fixHint:
              versionFailureHint ??
              "Repair or reinstall the staged OpenClaw package, then rerun the candidate check before cutover.",
          }),
        ];
      }

      const detectedVersion = parseCodexVersion(`${output.stdout}\n${output.stderr}`);
      if (detectedVersion !== expectedVersion) {
        return [
          managedCodexFinding({
            severity: versionFailureSeverity,
            message: detectedVersion
              ? `Managed Codex app-server version mismatch: expected ${expectedVersion}, detected ${detectedVersion}.`
              : `Managed Codex app-server did not report a parseable version; expected ${expectedVersion}.`,
            path: nativeCommand,
            requirement: `the exact selected Codex package version ${expectedVersion}`,
            fixHint:
              versionFailureHint ??
              "Repair the selected managed Codex package so its native executable matches the expected version, then rerun the candidate check.",
          }),
        ];
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
