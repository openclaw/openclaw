import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { processPollLivenessEntrypoint } from "./bash-tools.process-liveness-runtime.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

test("waiting process poll keeps a one-shot runtime alive through background completion", () => {
  const workspace = tempDirs.make("openclaw-process-poll-liveness-");
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const resultPath = path.join(workspace, "result.txt");
  // No IPC, server, or keepalive in this child: Vitest must not mask Node liveness.
  const child = spawnSync(
    process.execPath,
    [
      ...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(processPollLivenessEntrypoint)),
      workspace,
    ],
    {
      cwd: root,
      env: {
        HOME: workspace,
        USERPROFILE: workspace,
        OPENCLAW_STATE_DIR: workspace,
        OPENCLAW_CONFIG_PATH: path.join(workspace, "openclaw.json"),
        NODE_ENV: "test",
      },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 20_000,
      killSignal: "SIGKILL",
    },
  );
  expect(child.error, child.stderr).toBeUndefined();
  expect(child.status === 0 || child.status === 13, child.stderr).toBe(true);
  expect(readFileSync(resultPath, "utf8"), child.stderr).toBe("background-complete");
  expect(child.signal, child.stderr).toBeNull();
  expect(child.status, child.stderr).toBe(0);
  expect(JSON.parse(child.stdout)).toMatchObject({
    details: { status: "completed", exitCode: 0 },
    content: [{ type: "text", text: expect.stringContaining("Process exited with code 0.") }],
  });
}, 25_000);
