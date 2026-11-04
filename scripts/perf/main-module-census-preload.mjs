// Benchmark IPC only: observing one main isolate must not load source runtime graphs.
import { writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { getHeapCodeStatistics } from "node:v8";
import { isMainThread } from "node:worker_threads";

if (isMainThread) {
  if (!process.send) {
    throw new Error("Main module census requires a private benchmark IPC channel");
  }
  let coverage;
  async function onMessage(message) {
    if (message?.channel !== "main-module-census") {
      return;
    }
    try {
      const code = getHeapCodeStatistics();
      if (message.action === "coverage-start") {
        coverage = new Session();
        coverage.connect();
        await coverage.post("Profiler.enable");
        await coverage.post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
      } else if (message.action === "capture") {
        const session = coverage ?? new Session();
        if (!coverage) {
          session.connect();
        }
        const scripts = [];
        session.on("Debugger.scriptParsed", ({ params }) => {
          scripts.push({
            scriptId: params.scriptId,
            url: params.url,
            hash: params.hash,
            length: params.length,
            isModule: params.isModule,
          });
        });
        try {
          const execution = coverage
            ? (await session.post("Profiler.takePreciseCoverage")).result
            : undefined;
          await session.post("Debugger.enable");
          for (const script of scripts) {
            const { scriptSource, bytecode } = await session.post("Debugger.getScriptSource", {
              scriptId: script.scriptId,
            });
            script.sourceBytes = Buffer.byteLength(scriptSource);
            if (bytecode !== undefined) {
              script.bytecodeBytes = Buffer.byteLength(bytecode, "base64");
            }
          }
          writeFileSync(
            message.output,
            JSON.stringify({
              pid: process.pid,
              at: Date.now(),
              code,
              scripts,
              execution,
              coverage: Boolean(coverage),
            }),
          );
        } finally {
          if (coverage) {
            await session.post("Profiler.stopPreciseCoverage");
            await session.post("Profiler.disable");
          }
          session.disconnect();
          coverage = undefined;
        }
      }
      process.send({ channel: message.channel, id: message.id, code });
    } catch (error) {
      process.send({ channel: message.channel, id: message.id, error: String(error) });
    }
  }
  process.on("message", (message) => {
    void onMessage(message);
  });
  process.channel?.unref();
}
