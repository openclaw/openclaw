// Real behavior proof: `runExecResolver` handles real stdout/stderr stream
// error events without crashing the agent during secret resolution.
//
// The proof configures a real exec secret provider, calls the production
// `resolveSecretRefString` path, and patches `child_process.spawn` so the exec
// child is a real process whose stdout/stderr streams emit `error` events
// after the fix's listeners are attached. With the fix the secret still
// resolves; without the stream error listeners the unhandled errors would
// terminate the process.

import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process") as typeof import("node:child_process");
const originalSpawn = childProcess.spawn;

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-proof-secrets-"));
const fakeSecret = path.join(tmpDir, "secret-provider");

// Fake exec secret provider that returns the requested secret as JSON.
await fs.writeFile(
  fakeSecret,
  `#!/bin/sh
echo '{"protocolVersion":1,"values":{"my-secret":"super-secret-value"}}'
`,
  "utf8",
);
await fs.chmod(fakeSecret, 0o755);

// Patch spawn so the exec child is a real process whose streams we can make
// emit error events after runExecResolver attaches listeners.
childProcess.spawn = (...args: Parameters<typeof originalSpawn>) => {
  const child = originalSpawn.apply(childProcess, args);
  const cmd = args[0] ?? "";
  if (cmd === fakeSecret) {
    setTimeout(() => {
      child.stdout?.emit("error", new Error("stdout read failed"));
      child.stderr?.emit("error", new Error("stderr read failed"));
    }, 50);
  }
  return child;
};

const { resolveSecretRefString } = await import(path.join(repoRoot, "src/secrets/resolve.js"));

const config = {
  secrets: {
    providers: {
      default: {
        source: "exec" as const,
        command: fakeSecret,
      },
    },
    defaults: {
      exec: "default",
    },
  },
};

console.log("=== Proof: secrets resolve stream error catch ===\n");

try {
  const value = await resolveSecretRefString(
    { source: "exec", provider: "default", id: "my-secret" },
    { config: config as never },
  );
  console.log(`Resolved secret value: ${value}`);
  if (value === "super-secret-value") {
    console.log("\nPASS: stream errors were caught and secret resolution still succeeded.");
  } else {
    console.log("\nFAIL: unexpected secret value.");
    process.exitCode = 1;
  }
} catch (err) {
  console.error("\nFAIL: resolveSecretRefString rejected with:");
  console.error(err);
  process.exitCode = 1;
} finally {
  await fs.rm(tmpDir, { recursive: true, force: true });
}
