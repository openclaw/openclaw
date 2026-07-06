// Real behavior proof: `spawnGogServe` handles real stdout/stderr stream
// error events without crashing the gateway.
//
// The proof prepends a fake `gog` binary to PATH so `startGmailWatcher` can
// reach `spawnGogServe`, then patches `child_process.spawn` so the serve child
// is a real process whose streams emit real `error` events after the fix's
// listeners are attached. With the fix the watcher still starts; without the
// stream error listeners the unhandled errors would terminate the process.

import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process") as typeof import("node:child_process");
const originalSpawn = childProcess.spawn;

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-proof-gog-"));
const fakeGog = path.join(tmpDir, "gog");

// Fake gog that succeeds for `watch start` and sleeps for `watch serve`.
await fs.writeFile(
  fakeGog,
  `#!/bin/sh
if [ "$1" = "gmail" ] && [ "$2" = "watch" ]; then
  if [ "$3" = "start" ]; then
    echo "watch started"
    exit 0
  fi
  if [ "$3" = "serve" ]; then
    while true; do sleep 1; done
  fi
fi
echo "unknown command" >&2
exit 1
`,
  "utf8",
);
await fs.chmod(fakeGog, 0o755);

process.env.PATH = `${tmpDir}${path.delimiter}${process.env.PATH ?? ""}`;

// Patch spawn so the serve child is a real process whose streams we can make
// emit error events after startGmailWatcher attaches listeners.
childProcess.spawn = (...args: Parameters<typeof originalSpawn>) => {
  const child = originalSpawn.apply(childProcess, args);
  const cmd = args[0] ?? "";
  const argv = args[1] as string[] | undefined;
  if (cmd === "gog" || argv?.[0] === "gmail") {
    setTimeout(() => {
      child.stdout?.emit("error", new Error("gog stdout read failed"));
      child.stderr?.emit("error", new Error("gog stderr read failed"));
    }, 100);
  }
  return child;
};

const { startGmailWatcher, stopGmailWatcher } = await import(
  path.join(repoRoot, "src/hooks/gmail-watcher.js")
);

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

console.log("=== Proof: gmail-watcher stream error catch ===\n");

try {
  const result = await startGmailWatcher(config);
  if (result.started) {
    console.log("Watcher started successfully.");
    console.log("\nPASS: stream errors were caught and startGmailWatcher still resolved.");
  } else {
    console.log(`\nFAIL: watcher did not start: ${result.reason ?? "unknown"}`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error("\nFAIL: startGmailWatcher rejected with:");
  console.error(err);
  process.exitCode = 1;
} finally {
  try {
    await stopGmailWatcher();
  } catch {
    // ignore
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
}
