import { fileURLToPath } from "node:url";
import { quoteCliArg, quotePowerShellArg } from "../cli/quote-cli-arg.js";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { resolveRuntimeWorkerArgv } from "../infra/runtime-worker-url.js";
import { normalizeGitLabIssuer } from "./gitlab-host.js";

const ambientGitLabVariables = [
  "GITLAB_TOKEN",
  "GITLAB_ACCESS_TOKEN",
  "OAUTH_TOKEN",
  "CI_JOB_TOKEN",
  "GITLAB_CI",
  "GLAB_CI",
  "CI_SERVER_FQDN",
  "CI_SERVER_HOST",
  "GITLAB_HOST",
  "GITLAB_URI",
  "GL_HOST",
  "GITLAB_API_HOST",
  "GLAB_API_HOST",
  "GITLAB_SUBFOLDER",
  "GLAB_API_PROTOCOL",
  "API_PROTOCOL",
  "GLAB_CONFIG_DIR",
] as const;

/** Carry only the selected profile path and HTTPS issuer through supervision. */
export function buildGitLabExecLaunchArgv(
  argv: string[],
  profileDir: string,
  options: {
    issuer: string;
    externalCommandShell?: { shell: string; args: readonly string[] };
  },
): string[] {
  const workerUrl = resolveRuntimeProcessEntrypointUrl("gitlabExec");
  const issuer = normalizeGitLabIssuer(options.issuer);
  const host = new URL(issuer).host;
  const launcher = [process.execPath, ...resolveRuntimeWorkerArgv(workerUrl), profileDir, issuer];
  if (process.platform === "win32") {
    const externalShell = options.externalCommandShell;
    const shellArgv = externalShell
      ? [
          externalShell.shell,
          ...externalShell.args,
          `$ErrorActionPreference = 'Stop'; & ${argv.map(quotePowerShellArg).join(" ")}; exit $LASTEXITCODE`,
        ]
      : argv;
    const command = shellArgv.at(-1);
    if (command === undefined) {
      throw new Error("Managed GitLab execution requires a shell command.");
    }
    const resolverDir = quotePowerShellArg(fileURLToPath(new URL(".", workerUrl)));
    const clearAmbient = ambientGitLabVariables.map((name) => `$env:${name} = '';`).join(" ");
    const bootstrap = [
      clearAmbient,
      `Push-Location -LiteralPath ${resolverDir} -ErrorAction Stop;`,
      `try { $env:GITLAB_TOKEN = & ${launcher.map(quotePowerShellArg).join(" ")};`,
      "if (-not $? -or $LASTEXITCODE -ne 0 -or [string]::IsNullOrEmpty($env:GITLAB_TOKEN)) { exit 1 }",
      "} finally { Pop-Location };",
      `$env:GITLAB_HOST = ${quotePowerShellArg(host)};`,
      `$env:GLAB_CONFIG_DIR = ${quotePowerShellArg(profileDir)};`,
      "$env:GLAB_API_PROTOCOL = 'https'; $LASTEXITCODE = $null;",
      `& ([scriptblock]::Create(${quotePowerShellArg(command)}))`,
    ].join(" ");
    return [...shellArgv.slice(0, -1), bootstrap];
  }
  // Shell exec preserves PID, PTY and inherited lineage fds. Resolver stdout stays in
  // this private substitution, never in supervisor messages or command argv.
  const resolverDir = quoteCliArg(fileURLToPath(new URL(".", workerUrl)));
  const enterResolverDir = `cd ${resolverDir} 2>/dev/null || { printf '%s\\n' 'GitLab Identity launcher is unavailable. Restart OpenClaw, then retry.' >&2; exit 1; }`;
  const bootstrap = `set +x; unset ${ambientGitLabVariables.join(" ")}; GITLAB_TOKEN="$(${enterResolverDir}; exec ${launcher.map(quoteCliArg).join(" ")})" || exit $?; GITLAB_HOST=${quoteCliArg(host)}; GLAB_CONFIG_DIR=${quoteCliArg(profileDir)}; GLAB_API_PROTOCOL=https; export GITLAB_TOKEN GITLAB_HOST GLAB_CONFIG_DIR GLAB_API_PROTOCOL; exec "$@"`;
  return ["/bin/sh", "-c", bootstrap, "openclaw-gitlab-exec", ...argv];
}
