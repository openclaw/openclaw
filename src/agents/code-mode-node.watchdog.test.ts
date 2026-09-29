import { expect, it } from "vitest";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import { CodeModeNodeProgress } from "./code-mode-node-progress.js";
import type { CodeModeWorkerThreadResult } from "./code-mode-worker-types.js";

it.skipIf(process.platform !== "linux")(
  "runs cells without per-evaluation native threads",
  async () => {
    const pool = new WorkerTaskPool<unknown, CodeModeWorkerThreadResult<undefined>>({
      workerUrl: new URL("./code-mode-node.watchdog.test-support.ts", import.meta.url),
      maxWorkers: 1,
    });
    try {
      for (let index = 0; index < 20; index++) {
        const result = await pool.run(
          {
            kind: "exec",
            source: "return watchdogThreads();",
            config: {
              timeoutMs: 5_000,
              memoryLimitBytes: 64 * 1024 * 1024,
              maxOutputBytes: 1024,
              maxPendingToolCalls: 16,
              maxSnapshotBytes: 1024,
            },
            progress: new CodeModeNodeProgress(1024).buffer,
            inlineHost: false,
            catalog: [],
            namespaces: [],
          },
          { timeoutMs: 5_000 },
        );
        expect(result).toMatchObject({
          status: "completed",
          value: { kind: "complete", json: "[]" },
        });
      }
    } finally {
      await pool.close();
    }
  },
);
