// Real behavior proof: both gateway and foreground Gmail watcher renewal
// intervals survive a failing `gog watch start` without crashing.
//
// This script builds fake `gog` executables on disk, prepends them to PATH, and
// runs the real watcher code. The fake gog succeeds on the initial `watch start`,
// runs `serve`, and then fails every subsequent `watch start` renewal. The proof
// verifies that:
//
//   1. The gateway watcher (`startGmailWatcher`) logs the renewal failure and
//      stays alive.
//   2. The foreground `openclaw webhooks gmail run` service (`runGmailService`)
//      logs the renewal failure and does not produce an unhandled rejection.
//
// To keep the proof fast, `setInterval` is accelerated by a large factor while
// still exercising the real production code and real subprocess.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const baseTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-proof-gog-"));
const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const originalPath = process.env.PATH ?? "";

const config = {
  hooks: {
    enabled: true,
    token: "hook-token",
    gmail: {
      account: "me@example.com",
      topic: "projects/demo/topics/gmail",
      pushToken: "push-token",
      renewEveryMinutes: 1,
      tailscale: { mode: "off" },
    },
  },
};

async function writeFakeGog(
  dir: string,
  options: { deleteAfterFirstStart: boolean; servePidFile?: string },
) {
  const counterFile = path.join(dir, "watch-start-count");
  const fakeGog = path.join(dir, "gog");
  const selfPath = fakeGog;
  const servePidFile = options.servePidFile ?? "";
  await fs.writeFile(counterFile, "0", "utf8");
  await fs.writeFile(
    fakeGog,
    `#!/bin/sh
set -e
command="$1"
subcommand="$2"
action="$3"
counter_file="${counterFile}"
self_path="${selfPath}"
serve_pid_file="${servePidFile}"
if [ "$command" = "gmail" ] && [ "$subcommand" = "watch" ]; then
  if [ "$action" = "start" ]; then
    count=$(cat "$counter_file")
    count=$((count + 1))
    echo "$count" > "$counter_file"
    if [ "$count" -gt 1 ]; then
      echo "gog watch start: renewal failed" >&2
      if [ "${options.deleteAfterFirstStart ? '1' : '0'}" = "1" ]; then
        rm -f "$self_path"
      fi
      exit 1
    fi
    echo "watch started"
    exit 0
  fi
  if [ "$action" = "serve" ]; then
    if [ -n "$serve_pid_file" ]; then
      echo $$ > "$serve_pid_file"
    fi
    trap 'exit 0' TERM
    while true; do
      sleep 1
    done
  fi
fi
echo "unknown gog command: $*" >&2
exit 1
`,
    "utf8",
  );
  await fs.chmod(fakeGog, 0o755);
  return fakeGog;
}

// Gateway proof: run directly in this process.
async function runGatewayProof(): Promise<{ ok: boolean; output: string }> {
  const dir = path.join(baseTmpDir, "gateway");
  await fs.mkdir(dir, { recursive: true });
  await writeFakeGog(dir, { deleteAfterFirstStart: false });
  process.env.PATH = `${dir}${path.delimiter}${process.env.PATH ?? ""}`;

  const originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = (callback, _delay, ...args) => {
    return originalSetInterval(callback, 100, ...args);
  };

  const { startGmailWatcher, stopGmailWatcher } = await import(
    path.join(repoRoot, "src/hooks/gmail-watcher.js")
  );

  let logs = "";
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const captureLog = (chunk: unknown, write: (text: string) => boolean) => {
    const text = typeof chunk === "string" ? chunk : "";
    logs += text;
    return write(text);
  };
  process.stdout.write = (chunk: unknown) => captureLog(chunk, originalStdoutWrite);
  process.stderr.write = (chunk: unknown) => captureLog(chunk, originalStderrWrite);

  try {
    const result = await startGmailWatcher(config);
    if (!result.started) {
      return { ok: false, output: `gateway start failed: ${result.reason ?? "unknown"}\n${logs}` };
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 3000);
    });
    await stopGmailWatcher();
    const renewalFailureLogged = logs.includes("watch start failed") || logs.includes("watch start error");
    return { ok: renewalFailureLogged, output: logs };
  } catch (err) {
    return { ok: false, output: `gateway error: ${String(err)}\n${logs}` };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    globalThis.setInterval = originalSetInterval;
    try {
      await stopGmailWatcher();
    } catch {
      // ignore
    }
  }
}

// Foreground proof: run in a child process because runGmailService installs
// signal handlers and does not return until shutdown.
async function runForegroundProof(): Promise<{ ok: boolean; output: string }> {
  const dir = path.join(baseTmpDir, "foreground");
  await fs.mkdir(dir, { recursive: true });
  const servePidFile = path.join(dir, "gog-serve.pid");
  await writeFakeGog(dir, { deleteAfterFirstStart: true, servePidFile });
  const configPath = path.join(dir, "openclaw.json");
  await fs.writeFile(configPath, JSON.stringify(config), "utf8");

  const childScript = path.join(dir, "foreground-proof.mjs");
  await fs.writeFile(
    childScript,
    `import fs from "node:fs";
import path from "node:path";
import { runGmailService } from "${path.join(repoRoot, "src/hooks/gmail-ops.js")}";

const servePidFile = "${servePidFile}";
const unhandled = [];
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED_REJECTION:", String(reason));
  unhandled.push(reason);
});

const originalSetInterval = globalThis.setInterval;
globalThis.setInterval = (callback, _delay, ...args) => {
  return originalSetInterval(callback, 100, ...args);
};

const servicePromise = runGmailService({});
servicePromise.catch((err) => {
  console.error("[foreground] service rejected:", String(err));
});

await new Promise((resolve) => {
  setTimeout(resolve, 3000);
});

// Terminate the fake gog watch serve child so the proof exits cleanly
// instead of relying on the spawnSync timeout.
try {
  const pid = fs.existsSync(servePidFile) ? Number(fs.readFileSync(servePidFile, "utf8").trim()) : 0;
  if (pid > 0) {
    process.kill(pid, "SIGTERM");
  }
} catch (err) {
  console.error("[foreground] failed to signal serve child:", String(err));
}

if (unhandled.length > 0) {
  console.error("FOREGROUND_UNHANDLED_COUNT:", unhandled.length);
  process.exit(2);
}
console.log("FOREGROUND_DONE");
process.exit(0);
`,
    "utf8",
  );

  const result = spawnSync("node_modules/.bin/tsx", [childScript], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${dir}${path.delimiter}${originalPath}`,
      OPENCLAW_LOG_LEVEL: "info",
      OPENCLAW_CONFIG_PATH: configPath,
    },
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 15_000,
  });

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const noUnhandled = !output.includes("UNHANDLED_REJECTION");
  const renewalLogged = output.includes("renewal failed") || output.includes("watch start error");
  const spawnOk = result.error === undefined;
  return { ok: spawnOk && result.status === 0 && noUnhandled && renewalLogged, output };
}

console.log("=== Proof: gmail-watcher renewal interval rejection catch ===\n");

const gateway = await runGatewayProof();
const foreground = await runForegroundProof();

try {
  await fs.rm(baseTmpDir, { recursive: true, force: true });
} catch {
  // ignore cleanup failures
}

console.log("\n=== Gateway watcher log excerpt ===");
console.log(
  gateway.output
    .split("\n")
    .filter((line) => line.includes("gmail-watcher") || line.includes("watch start"))
    .slice(-15)
    .join("\n"),
);

console.log("\n=== Foreground service full output ===");
console.log(foreground.output || "(empty)");

console.log("\n=== Results ===");
console.log(`Gateway watcher: ${gateway.ok ? "PASS" : "FAIL"}`);
console.log(`Foreground service: ${foreground.ok ? "PASS" : "FAIL"}`);

if (gateway.ok && foreground.ok) {
  console.log("\nPASS: both gateway and foreground watchers survive a renewal failure.");
} else {
  console.log("\nFAIL: one or more proof steps did not pass.");
  process.exitCode = 1;
}
