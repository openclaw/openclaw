import {
  GITHUB_EXEC_CREDENTIAL_UNAVAILABLE,
  readGitHubExecToken,
} from "./github-exec-credential.js";

// The shell bootstrap captures stdout privately; it must never become tool output.
// Keep this entrypoint free of runtime logging, worker IPC and credential caching.
async function resolveCredential() {
  const token = await readGitHubExecToken(process.argv[2] ?? "", process.argv[3]);
  process.stdout.write(token);
}

function credentialUnavailable(stage: "credential-read" | "credential-output") {
  process.exitCode = 1;
  process.stderr.write(`${GITHUB_EXEC_CREDENTIAL_UNAVAILABLE}\nGitHub Identity stage: ${stage}\n`);
}

// A cancelled private pipe must not turn a credential error into an uncaught stream stack.
process.stdout.on("error", () => credentialUnavailable("credential-output"));
process.stderr.on("error", () => {
  process.exitCode = 1;
});
void resolveCredential().catch(() => credentialUnavailable("credential-read"));
