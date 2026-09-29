import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "openclaw/plugin-sdk/process-runtime";
import { resolveTestNodeExecPath } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it } from "vitest";
import { busServerShutdownEntrypoint } from "./bus-server-runtime.test-support.js";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const nodeExecPath = resolveTestNodeExecPath();

// Vitest's own handles would keep an unreferenced shutdown timer alive.
it.each(["bus", "provider"])("finishes %s shutdown after rejecting an upload", async (kind) => {
  const { stdout, stderr } = await execFileAsync(
    nodeExecPath,
    [
      ...resolveRuntimeWorkerArgv(
        resolveRuntimeWorkerUrl(busServerShutdownEntrypoint),
        nodeExecPath,
      ),
      kind,
    ],
    { cwd: repoRoot, encoding: "utf8", timeout: 20_000 },
  );
  expect(stdout.trim()).toBe("shutdown-complete");
  expect(stderr).toBe("");
});
