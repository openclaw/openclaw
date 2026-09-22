import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

test("waiting process poll keeps a one-shot runtime alive through background completion", () => {
  const workspace = tempDirs.make("openclaw-process-poll-liveness-");
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const resultPath = path.join(workspace, "result.txt");
  const command =
    'setTimeout(() => { require("node:fs").writeFileSync("result.txt", "background-complete"); }, 80)';
  const source = `
    import { runExecProcess } from "./src/agents/bash-tools.exec-runtime.ts";
    import { markBackgrounded } from "./src/agents/bash-process-registry.ts";
    import { createProcessTool } from "./src/agents/bash-tools.process.ts";

    const run = await runExecProcess({
      command: "one-shot poll liveness",
      workdir: ${JSON.stringify(workspace)},
      env: {},
      sandbox: {
        containerName: "poll-liveness-fixture",
        workspaceDir: ${JSON.stringify(workspace)},
        containerWorkdir: ${JSON.stringify(workspace)},
        async buildExecSpec() {
          return {
            argv: [process.execPath, "-e", ${JSON.stringify(command)}],
            env: {},
            stdinMode: "pipe-closed",
          };
        },
      },
      usePty: false,
      warnings: [],
      maxOutput: 1000,
      pendingMaxOutput: 1000,
      notifyOnExit: false,
      timeoutSec: 0,
    });
    markBackgrounded(run.session);
    try {
      const result = await createProcessTool().execute("poll", {
        action: "poll", sessionId: run.session.id, timeout: 5000,
      });
      process.stdout.write(JSON.stringify(result) + "\\n");
    } finally {
      run.kill();
      await run.promise;
    }
  `;
  // No IPC, server, or keepalive in this child: Vitest must not mask Node liveness.
  const child = spawnSync(
    process.execPath,
    ["--import", "./scripts/tsx.mjs", "--input-type=module", "-e", source],
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
