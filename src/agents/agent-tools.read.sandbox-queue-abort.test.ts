import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createAbortError } from "../infra/abort-signal.js";
import { createSandboxedReadTool, createSandboxedWriteTool } from "./agent-tools.read.js";
import { createSandboxFsBridge } from "./sandbox/fs-bridge.js";
import { createSandboxTestContext } from "./sandbox/test-fixtures.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["access", "read", "stat"] as const)(
  "releases the same file after aborting a sandbox %s command",
  async (phase) => {
    const root = tempDirs.make("sandbox-file-queue-abort-");
    await fs.writeFile(path.join(root, "same.txt"), "original\n");
    await fs.writeFile(path.join(root, "other.txt"), "independent\n");
    const entered = createDeferred();
    const release = createDeferred();
    const commandAborted = vi.fn();
    let statCompleted = false;
    let held = false;
    const bridge = createSandboxFsBridge({
      sandbox: {
        ...createSandboxTestContext({ overrides: { workspaceDir: root, agentWorkspaceDir: root } }),
        backend: {
          async runShellCommand({ script, args = [], signal }) {
            const identity = args[2] === "1";
            if (
              !held &&
              !identity &&
              args[0] === "/workspace/same.txt" &&
              (phase !== "read" || statCompleted)
            ) {
              held = true;
              entered.resolve();
              const abort = () => {
                commandAborted();
                release.reject(createAbortError("Aborted"));
              };
              signal?.addEventListener("abort", abort, { once: true });
              try {
                await release.promise;
              } finally {
                signal?.removeEventListener("abort", abort);
              }
            }
            if (script.includes('stat -c "%F|%s|%y"')) {
              statCompleted = true;
              return {
                stdout: Buffer.from("regular file|9|2026-01-01 00:00:00 +0000"),
                stderr: Buffer.alloc(0),
                code: 0,
              };
            }
            return { stdout: Buffer.from(`${args[0]}\n`), stderr: Buffer.alloc(0), code: 0 };
          },
        },
      },
    });
    const controller = new AbortController();
    const read = createSandboxedReadTool({ root: "/workspace", bridge });
    const firstTool =
      phase === "stat" ? createSandboxedWriteTool({ root: "/workspace", bridge }) : read;
    const first = firstTool.execute(
      "run-a",
      { path: "same.txt", content: "replacement" },
      controller.signal,
    );
    const rejected = expect(first).rejects.toThrow(/abort/i);
    let retry: ReturnType<typeof read.execute> | undefined;
    let retryFinished = false;
    try {
      await entered.promise;
      retry = read.execute("run-b", { path: "same.txt" }).then((result) => {
        retryFinished = true;
        return result;
      });
      await expect(read.execute("unrelated", { path: "other.txt" })).resolves.toMatchObject({
        content: [{ type: "text", text: expect.stringContaining("independent") }],
      });
      expect(retryFinished).toBe(false);
      controller.abort();
      // Observer cancellation alone is insufficient: the container command must settle.
      expect(commandAborted).toHaveBeenCalledOnce();
      await rejected;
      await expect(retry).resolves.toMatchObject({
        content: [{ type: "text", text: expect.stringContaining("original") }],
      });
    } finally {
      release.resolve();
      await Promise.allSettled([first, rejected, retry]);
    }
  },
);
