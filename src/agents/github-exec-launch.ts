import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getWindowsNativeRedirectStartup } from "../../cli-invocation.mjs";
import { CLI_PARENT_BOUND_PRELOAD } from "../../cli-parent-lifetime.mjs";
import { quoteCliArg, quotePowerShellArg } from "../cli/quote-cli-arg.js";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { resolveRuntimeWorkerArgv } from "../infra/runtime-worker-url.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { GITHUB_PUBLIC_HOST, resolveConfiguredGitHubHost } from "./github-host.js";

const log = createSubsystemLogger("agents/github-exec");
type NativeRedirectStage = "native-roots" | "native-layout" | "native-startup-import";

function skipNativeRedirect(stage: NativeRedirectStage): undefined {
  log.debug("Managed GitHub resolver startup", { stage });
  return undefined;
}

function resolveWindowsNativeRedirect(workerUrl: URL) {
  if (process.platform !== "win32" || workerUrl.protocol !== "file:") {
    return undefined;
  }
  const workerPath = fileURLToPath(workerUrl);
  if (path.basename(workerPath) !== "github-exec-launcher.js") {
    return undefined;
  }
  const startup = getWindowsNativeRedirectStartup();
  if (!startup || (!startup.appRoot && !startup.stagedRoot)) {
    return undefined;
  }
  const { appRoot, stagedRoot, execArgv } = startup;
  if (!appRoot || !stagedRoot || !path.isAbsolute(appRoot) || !path.isAbsolute(stagedRoot)) {
    return skipNativeRedirect("native-roots");
  }
  const derivedAppRoot = path.resolve(workerPath, "..", "..", "..");
  const expectedWorker = path.join(derivedAppRoot, "dist", "agents", "github-exec-launcher.js");
  if (workerPath !== expectedWorker) {
    return skipNativeRedirect("native-layout");
  }
  const preloadPath = (root: string) => path.join(root, "..", "node", "native-redirect.mjs");
  try {
    const realAppRoot = realpathSync.native(derivedAppRoot);
    if (
      path.basename(realAppRoot).toLowerCase() !== "app" ||
      realpathSync.native(appRoot) !== realAppRoot
    ) {
      return skipNativeRedirect("native-roots");
    }
    // Compile-cache and entry respawns can each prepend the lifetime import.
    let offset = execArgv[0] === "--import" && execArgv[1] === CLI_PARENT_BOUND_PRELOAD ? 2 : 0;
    if (/^--stack[-_]size=\d+$/u.test(execArgv[offset] ?? "")) {
      offset++;
    }
    if (execArgv[offset] === "--import" && execArgv[offset + 1] === CLI_PARENT_BOUND_PRELOAD) {
      offset += 2;
    }
    const option = execArgv[offset];
    const operand =
      option === "--import" ? execArgv[offset + 1] : option?.match(/^--import=(.+)$/u)?.[1];
    const expectedPreload = preloadPath(realAppRoot);
    if (!operand || operand.includes("?") || operand.includes("#")) {
      return skipNativeRedirect("native-startup-import");
    }
    const operandPath = fileURLToPath(operand);
    // The Windows launcher and Node can encode the same file path differently.
    const allowed = [preloadPath(appRoot), expectedPreload];
    if (!allowed.some((file) => path.resolve(file).toLowerCase() === operandPath.toLowerCase())) {
      return skipNativeRedirect("native-startup-import");
    }
    if (realpathSync.native(operandPath) !== expectedPreload) {
      return skipNativeRedirect("native-layout");
    }
    return { preload: pathToFileURL(expectedPreload).href, appRoot, stagedRoot };
  } catch {
    // Filesystem errors can contain private paths.
    return skipNativeRedirect("native-layout");
  }
}

/** Carry only a selected profile path through supervision; resolve its token in the child. */
export function buildGitHubExecLaunchArgv(
  argv: string[],
  profileDir: string,
  options?: {
    githubHost?: string;
    externalCommandShell?: { shell: string; args: readonly string[] };
  },
): string[] {
  const workerUrl = resolveRuntimeProcessEntrypointUrl("githubExec");
  const host = resolveConfiguredGitHubHost({ gateway: { github: { host: options?.githubHost } } });
  const nativeRedirect = resolveWindowsNativeRedirect(workerUrl);
  const launcher = [
    process.execPath,
    ...(nativeRedirect ? ["--import", nativeRedirect.preload] : []),
    ...resolveRuntimeWorkerArgv(workerUrl),
    profileDir,
    host,
  ];
  // GH_HOST is a default, not an authentication boundary. Do not expose a public
  // token through the Enterprise family when a command selects a different host.
  const publicToken = host === GITHUB_PUBLIC_HOST || host.endsWith(".ghe.com");
  if (process.platform === "win32") {
    const externalShell = options?.externalCommandShell;
    const shellArgv = externalShell
      ? [
          externalShell.shell,
          ...externalShell.args,
          `$ErrorActionPreference = 'Stop'; & ${argv.map(quotePowerShellArg).join(" ")}; exit $LASTEXITCODE`,
        ]
      : argv;
    // getShellConfig owns a fresh PowerShell -Command process on Windows. Keep it as
    // the command owner; a Node wrapper's private Job could kill retained descendants.
    const command = shellArgv.at(-1);
    if (command === undefined) {
      throw new Error("Managed GitHub execution requires a shell command.");
    }
    const resolverDir = quotePowerShellArg(fileURLToPath(new URL(".", workerUrl)));
    const resolveToken = `& ${launcher.map(quotePowerShellArg).join(" ")}`;
    // Pin the roots only for the credential child; restore the command's original environment.
    const credentialInvocation = nativeRedirect
      ? [
          "$openclawPriorApp = $env:OPENCLAW_NATIVE_APP_ROOT;",
          "$openclawPriorStage = $env:OPENCLAW_NATIVE_STAGED_ROOT;",
          "try {",
          `$env:OPENCLAW_NATIVE_APP_ROOT = ${quotePowerShellArg(nativeRedirect.appRoot)};`,
          `$env:OPENCLAW_NATIVE_STAGED_ROOT = ${quotePowerShellArg(nativeRedirect.stagedRoot)};`,
          `$env:GH_TOKEN = ${resolveToken};`,
          "if (-not $? -or $LASTEXITCODE -ne 0 -or [string]::IsNullOrEmpty($env:GH_TOKEN)) { exit 1 }",
          "} finally {",
          "$env:OPENCLAW_NATIVE_APP_ROOT = $openclawPriorApp;",
          "$env:OPENCLAW_NATIVE_STAGED_ROOT = $openclawPriorStage;",
          "Remove-Variable openclawPriorApp, openclawPriorStage",
          "}",
        ].join(" ")
      : `$env:GH_TOKEN = ${resolveToken}; if (-not $? -or $LASTEXITCODE -ne 0 -or [string]::IsNullOrEmpty($env:GH_TOKEN)) { exit 1 }`;
    const bootstrap = [
      `Push-Location -LiteralPath ${resolverDir} -ErrorAction Stop;`,
      `try { ${credentialInvocation}`,
      "} finally { Pop-Location };",
      `$env:GH_HOST = ${quotePowerShellArg(host)};`,
      publicToken
        ? "$env:GH_ENTERPRISE_TOKEN = '';"
        : "$env:GH_ENTERPRISE_TOKEN = $env:GH_TOKEN; $env:GH_TOKEN = '';",
      "$env:GITHUB_TOKEN = ''; $env:GITHUB_ENTERPRISE_TOKEN = ''; $LASTEXITCODE = $null;",
      `& ([scriptblock]::Create(${quotePowerShellArg(command)}))`,
    ].join(" ");
    return [...shellArgv.slice(0, -1), bootstrap];
  }
  // Shell exec preserves PID, PTY and inherited lineage fds. Resolver stdout stays inside
  // this private substitution; neither supervisor/relay messages nor argv carry the token.
  // Resolve source-mode tsx beside application code; only the substitution changes cwd.
  const resolverDir = quoteCliArg(fileURLToPath(new URL(".", workerUrl)));
  const enterResolverDir = `cd ${resolverDir} 2>/dev/null || { printf '%s\\n' 'GitHub Identity launcher is unavailable. Restart OpenClaw, then retry.' >&2; exit 1; }`;
  const bootstrap = `set +x; GH_TOKEN="$(${enterResolverDir}; exec ${launcher.map(quoteCliArg).join(" ")})" || exit $?; GH_HOST=${quoteCliArg(host)}; ${publicToken ? "GH_ENTERPRISE_TOKEN=;" : "GH_ENTERPRISE_TOKEN=$GH_TOKEN; GH_TOKEN=;"} GITHUB_TOKEN=; GITHUB_ENTERPRISE_TOKEN=; export GH_HOST GH_TOKEN GH_ENTERPRISE_TOKEN GITHUB_TOKEN GITHUB_ENTERPRISE_TOKEN; exec "$@"`;
  return ["/bin/sh", "-c", bootstrap, "openclaw-github-exec", ...argv];
}
