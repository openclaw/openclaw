import {
  GITLAB_EXEC_CREDENTIAL_UNAVAILABLE,
  readGitLabExecToken,
} from "./gitlab-exec-credential.js";

// The shell bootstrap captures stdout privately; never log or forward it as tool output.
async function resolveCredential() {
  const token = await readGitLabExecToken(process.argv[2] ?? "", process.argv[3] ?? "");
  process.stdout.write(token);
}

function credentialUnavailable() {
  process.exitCode = 1;
  process.stderr.write(`${GITLAB_EXEC_CREDENTIAL_UNAVAILABLE}\n`);
}

process.stdout.on("error", credentialUnavailable);
process.stderr.on("error", () => {
  process.exitCode = 1;
});
void resolveCredential().catch(credentialUnavailable);
