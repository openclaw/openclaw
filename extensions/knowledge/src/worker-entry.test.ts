import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";

// mock-isolation: loading the real lifecycle module is the regression this boundary rejects.
vi.mock("openclaw/plugin-sdk/database-engine-worker-runtime", () => {
  throw new Error("Knowledge's SQLite worker must not load host database engine lifecycle");
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("loads storage operations without host database engine lifecycle", async () => {
  const { operations } = await import("./storage-host.js");
  expect(operations.sourceCheck).toBeTypeOf("function");
  expect(operations.history).toBeTypeOf("function");
});

it.each(["registry", "storage"])(
  "starts the %s worker with its host-selected SDK",
  async (name) => {
    const root = tempDirs.make("knowledge-worker-entry-");
    const entry = path.join(root, `${name}-worker.mjs`);
    await build({
      entryPoints: [fileURLToPath(new URL(`./${name}-worker.ts`, import.meta.url))],
      outfile: entry,
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      external: ["./registry-host.js", "./storage-host.js"],
    });
    const sdk = path.join(root, "host SDK #.mjs");
    await writeFile(sdk, 'export const marker = "host-selected-sdk";');
    // The lazy host boundary consumes an alias absent from node_modules and an ordinary builtin.
    await writeFile(
      path.join(root, `${name}-host.js`),
      `import { marker } from "openclaw/plugin-sdk/worker-fixture";
import { basename } from "node:path";
export function ${name === "registry" ? "serveRegistry" : "serve"}(port, data) {
  port.postMessage({ marker, basename: basename(${name === "registry" ? "data" : "data.config.root"}) });
  port.close();
}`,
    );
    await writeFile(path.join(root, "package.json"), '{"type":"module"}');
    const runner = path.join(root, "run.mjs");
    await writeFile(
      runner,
      `import { once } from "node:events";
import { Worker } from "node:worker_threads";
const worker = new Worker(new URL(${JSON.stringify(pathToFileURL(entry).href)}), {
  workerData: {
    sdk: { "openclaw/plugin-sdk/worker-fixture": ${JSON.stringify(pathToFileURL(sdk).href)} },
    files: { root: ${JSON.stringify(root)}, extension: ".js" },
    stateRoot: "/synthetic-state",
    config: { root: "/synthetic-state" },
    signal: new SharedArrayBuffer(8),
  },
});
try {
  const [message] = await once(worker, "message");
  console.log(JSON.stringify(message));
} finally {
  await worker.terminate();
}`,
    );
    const { stdout } = await promisify(execFile)(process.execPath, [runner], { timeout: 10_000 });
    expect(JSON.parse(stdout)).toEqual({
      marker: "host-selected-sdk",
      basename: "synthetic-state",
    });
  },
);
