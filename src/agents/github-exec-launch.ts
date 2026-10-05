import { fileURLToPath } from "node:url";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { resolveRuntimeWorkerArgv } from "../infra/runtime-worker-url.js";
import { resolveConfiguredGitHubHost } from "./github-host.js";

function quotePowerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
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
  const launcher = [process.execPath, ...resolveRuntimeWorkerArgv(workerUrl), profileDir, host];
  if (process.platform === "win32") {
    const externalShell = options?.externalCommandShell;
    const shellArgv = externalShell
      ? [
          externalShell.shell,
          ...externalShell.args,
          `$ErrorActionPreference = 'Stop'; & ${argv.map(quotePowerShellLiteral).join(" ")}; exit $LASTEXITCODE`,
        ]
      : argv;
    // getShellConfig owns a fresh PowerShell -Command process on Windows. Keep it as
    // the command owner; a Node wrapper's private Job could kill retained descendants.
    const command = shellArgv.at(-1);
    if (command === undefined) {
      throw new Error("Managed GitHub execution requires a shell command.");
    }
    const resolverDir = quotePowerShellLiteral(fileURLToPath(new URL(".", workerUrl)));
    const bootstrap = [
      `Push-Location -LiteralPath ${resolverDir} -ErrorAction Stop;`,
      `try { $env:GH_TOKEN = & ${launcher.map(quotePowerShellLiteral).join(" ")};`,
      "if (-not $? -or $LASTEXITCODE -ne 0 -or [string]::IsNullOrEmpty($env:GH_TOKEN)) { exit 1 }",
      "} finally { Pop-Location };",
      `$env:GH_HOST = ${quotePowerShellLiteral(host)};`,
      "$env:GH_ENTERPRISE_TOKEN = $env:GH_TOKEN; $env:GITHUB_TOKEN = ''; $env:GITHUB_ENTERPRISE_TOKEN = ''; $LASTEXITCODE = $null;",
      `& ([scriptblock]::Create(${quotePowerShellLiteral(command)}))`,
    ].join(" ");
    return [...shellArgv.slice(0, -1), bootstrap];
  }
  // Shell exec preserves PID, PTY and inherited lineage fds. Resolver stdout stays inside
  // this private substitution; neither supervisor/relay messages nor argv carry the token.
  // Resolve source-mode tsx beside application code; only the substitution changes cwd.
  const resolverDir = quoteCliArg(fileURLToPath(new URL(".", workerUrl)));
  const enterResolverDir = `cd ${resolverDir} 2>/dev/null || { printf '%s\\n' 'GitHub Identity launcher is unavailable. Restart OpenClaw, then retry.' >&2; exit 1; }`;
  const bootstrap = `set +x; GH_TOKEN="$(${enterResolverDir}; exec ${launcher.map(quoteCliArg).join(" ")})" || exit $?; GH_HOST=${quoteCliArg(host)}; GH_ENTERPRISE_TOKEN=$GH_TOKEN; GITHUB_TOKEN=; GITHUB_ENTERPRISE_TOKEN=; export GH_HOST GH_TOKEN GH_ENTERPRISE_TOKEN GITHUB_TOKEN GITHUB_ENTERPRISE_TOKEN; exec "$@"`;
  return ["/bin/sh", "-c", bootstrap, "openclaw-github-exec", ...argv];
}
