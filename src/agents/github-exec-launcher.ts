import fs from "node:fs";
import {
  GITHUB_EXEC_CREDENTIAL_UNAVAILABLE,
  readGitHubExecToken,
  normalizeGitHubExecToken,
} from "./github-exec-credential.js";

// The shell bootstrap captures stdout privately; it must never become tool output.
// Keep this entrypoint free of runtime logging, worker IPC and credential caching.
async function resolveCredential() {
  let token: string;
  if (process.argv[2] === "--private-fd") {
    const data = fs.readFileSync(4);
    try {
      token = normalizeGitHubExecToken(data.toString("utf8"));
    } finally {
      data.fill(0);
      fs.closeSync(4);
    }
  } else {
    token = await readGitHubExecToken(process.argv[2] ?? "", process.argv[3]);
  }
  process.stdout.write(token);
}

function credentialUnavailable() {
  process.exitCode = 1;
  process.stderr.write(`${GITHUB_EXEC_CREDENTIAL_UNAVAILABLE}\n`);
}

// A cancelled private pipe must not turn a credential error into an uncaught stream stack.
process.stdout.on("error", credentialUnavailable);
process.stderr.on("error", () => {
  process.exitCode = 1;
});
void resolveCredential().catch(credentialUnavailable);
