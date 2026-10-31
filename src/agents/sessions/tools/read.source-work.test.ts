import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, expect, it } from "vitest";
import { runNodeScript } from "../../../../test/helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import type { ReadToolDetails } from "./tool-contracts.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let observed: { mode: string; bytesRead: number; details: ReadToolDetails }[];
beforeAll(async () => {
  const root = tempDirs.make("read-source-work-");
  const files = ["local.txt", "standalone.sqlite", "broker.sqlite"].map((name) =>
    path.join(root, name),
  );
  const logPath = path.join(root, "reads.log");
  const preload = path.join(root, "read-observer.mjs");
  await Promise.all(files.map((file) => fs.writeFile(file, "line\n".repeat(500_000))));
  await fs.writeFile(logPath, "");
  // Observe completed source I/O in every reader process, without replacing its bytes.
  await fs.writeFile(
    preload,
    `
import fs from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const sources = new Set(JSON.parse(process.env.READ_SOURCE_FILES));
const open = fs.open;
fs.open = async (...args) => {
  const handle = await open(...args);
  const file = String(args[0]);
  if (sources.has(file)) {
    let wholeRead = false;
    for (const name of ["read", "readFile"]) {
      const original = handle[name].bind(handle);
      handle[name] = async (...args) => {
        if (name === "readFile") wholeRead = true;
        try {
          const value = await original(...args);
          if (name === "readFile" || !wholeRead) {
            const bytes = name === "readFile" ? value.length : value.bytesRead;
            appendFileSync(process.env.READ_SOURCE_LOG, JSON.stringify({ file, bytes }) + "\\n");
          }
          return value;
        } finally {
          if (name === "readFile") wholeRead = false;
        }
      };
    }
  }
  return handle;
};
syncBuiltinESMExports();
`,
  );
  const result = await runNodeScript(
    (workerArgv) => [
      ...workerArgv(new URL("./read.source-work.test-support.ts", import.meta.url)),
      root,
      logPath,
    ],
    {
      ...process.env,
      NODE_OPTIONS: `--import=${preload}`,
      READ_SOURCE_FILES: JSON.stringify(files),
      READ_SOURCE_LOG: logPath,
      OPENCLAW_STATE_DIR: path.join(root, "state"),
    },
    120_000,
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  observed = JSON.parse(result.stdout.trim());
}, 120_000);

it.each(["local", "standalone", "broker"])("bounds source work in the %s reader", (mode) => {
  const result = observed.find((entry) => entry.mode === mode)!;
  expect(result.bytesRead).toBeGreaterThan(0);
  expect(result.bytesRead).toBeLessThanOrEqual(1024 * 1024 + 64 * 1024);
  expect(result.details.kind).toBe("truncated");
  if (result.details.kind !== "truncated") {
    throw new Error("Expected a bounded page");
  }
  expect(result.details.truncation).not.toHaveProperty("totalLines");
  expect(result.details.truncation).not.toHaveProperty("totalBytes");
});
