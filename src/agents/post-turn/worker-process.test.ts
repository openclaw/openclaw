import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";

describe("post-turn worker process", () => {
  it("runs a worker module in a child process with a JSON request", async () => {
    await withStateDirEnv("openclaw-post-turn-worker-", async ({ stateDir }) => {
      const { runPostTurnWorkerProcess } = await import("./worker-process.js");
      const markerPath = path.join(stateDir, "worker-marker.txt");
      const workerPath = path.join(stateDir, "worker.mjs");
      await fs.writeFile(
        workerPath,
        [
          "import fs from 'node:fs/promises';",
          "export async function runPostTurnWorkerFromCli() {",
          "  let raw = '';",
          "  process.stdin.setEncoding('utf8');",
          "  for await (const chunk of process.stdin) raw += chunk;",
          "  const request = JSON.parse(raw);",
          "  await fs.writeFile(request.markerPath, request.payload, 'utf8');",
          "}",
        ].join("\n"),
      );

      await runPostTurnWorkerProcess({
        workerModuleUrl: pathToFileURL(workerPath).href,
        request: { markerPath, payload: "worker-ok" },
        timeoutMs: 2_000,
      });

      await expect(fs.readFile(markerPath, "utf8")).resolves.toBe("worker-ok");
      await expect(fs.readdir(path.join(stateDir, "post-turn", "worker-requests"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("survives a crashing worker and reports the child exit code", async () => {
    await withStateDirEnv("openclaw-post-turn-worker-", async ({ stateDir }) => {
      const { runPostTurnWorkerProcess } = await import("./worker-process.js");
      const workerPath = path.join(stateDir, "crash-worker.mjs");
      await fs.writeFile(
        workerPath,
        [
          "export async function runPostTurnWorkerFromCli() {",
          "  process.exit(139);",
          "}",
        ].join("\n"),
      );

      await expect(
        runPostTurnWorkerProcess({
          workerModuleUrl: pathToFileURL(workerPath).href,
          request: { ok: true },
          timeoutMs: 2_000,
        }),
      ).rejects.toMatchObject({ exitCode: 139 });
    });
  });

  it("removes stale file-based worker requests from older builds", async () => {
    await withStateDirEnv("openclaw-post-turn-worker-", async ({ stateDir }) => {
      const { cleanupPostTurnWorkerRequestFiles, resolvePostTurnWorkerRequestDir } = await import(
        "./worker-process.js"
      );
      const requestDir = resolvePostTurnWorkerRequestDir();
      await fs.mkdir(requestDir, { recursive: true });
      await fs.writeFile(path.join(requestDir, "stale.json"), '{"private":"request"}', "utf8");

      await expect(cleanupPostTurnWorkerRequestFiles()).resolves.toBe(1);
      await expect(fs.readdir(path.join(stateDir, "post-turn", "worker-requests"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });
});
