// Diagnostic preload for compiled update workers, including native update captures.
// OPENCLAW_BENCH_UPDATE_LOAD_DIR=<dir> node --import <this file> <worker> <mode>
// Counts are load-independent. Compare CPU only under the campaign timing lock.
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread, threadId } from "node:worker_threads";

const output = process.env.OPENCLAW_BENCH_UPDATE_LOAD_DIR;
if (output) {
  mkdirSync(output, { recursive: true });
  const modules = new Map();
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (url.startsWith("file:") && result.format !== "addon") {
        modules.set(
          url,
          result.source == null
            ? statSync(fileURLToPath(url)).size
            : Buffer.byteLength(result.source),
        );
      }
      return result;
    },
  });
  process.once("exit", (exitCode) => {
    const runtime = process.argv[1] ?? "";
    writeFileSync(
      path.join(output, `load-${process.pid}-${threadId}.json`),
      `${JSON.stringify({
        mode: process.argv[2] ?? "finalize",
        entry: path.basename(runtime),
        mainThread: isMainThread,
        threadId,
        exitCode,
        cpu: process.threadCpuUsage(),
        processCpu: isMainThread ? process.cpuUsage() : undefined,
        modules: [...modules].map(([url, bytes]) => ({
          file: path.relative(path.dirname(runtime), fileURLToPath(url)),
          bytes,
        })),
        moduleCount: modules.size,
        loadedBytes: [...modules.values()].reduce((sum, bytes) => sum + bytes, 0),
      })}\n`,
    );
  });
}
