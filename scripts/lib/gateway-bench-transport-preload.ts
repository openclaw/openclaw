import { writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { isMainThread } from "node:worker_threads";
import { GATEWAY_PROFILE_CHANNEL, type GatewayBenchCommand } from "./gateway-bench-profile.ts";

type WorkCount = { calls: number; bytes: number };
const output = process.env.OPENCLAW_BENCH_TRANSPORT_COUNTS_PATH;

// This instrumentation allocates stacks; run it separately from timing and heap profiles.
if (isMainThread && output) {
  if (!process.send) {
    throw new Error("Transport counting requires the benchmark IPC channel");
  }
  const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
  let active = false;
  let concat: Record<string, WorkCount> = {};
  let nativeWrite: WorkCount = { calls: 0, bytes: 0 };
  let nativeWritev = { calls: 0, bytes: 0, chunks: 0 };
  const countBytes = (chunk: unknown): number =>
    typeof chunk === "string"
      ? Buffer.byteLength(chunk)
      : ArrayBuffer.isView(chunk)
        ? chunk.byteLength
        : 0;
  const concatenate = Buffer.concat.bind(Buffer);
  Buffer.concat = (chunks, totalLength) => {
    if (active) {
      const site =
        new Error().stack?.split("\n")[2]?.trim().replace(process.cwd(), ".") ?? "unknown";
      const count = (concat[site] ??= { calls: 0, bytes: 0 });
      count.calls++;
      count.bytes += totalLength ?? chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    }
    return concatenate(chunks, totalLength);
  };
  // Preserve the original receiver when calling the captured native method below.
  const write = Socket.prototype["_write"];
  Socket.prototype["_write"] = function (...args: Parameters<Socket["_write"]>) {
    if (active && this.localPort === port) {
      nativeWrite.calls++;
      nativeWrite.bytes += countBytes(args[0]);
    }
    return write.apply(this, args);
  };
  // Preserve the original receiver when calling the captured native method below.
  const writev = Socket.prototype["_writev"];
  if (!writev) {
    throw new Error("This Node runtime has no Socket._writev transport counter boundary");
  }
  Socket.prototype["_writev"] = function (...args: Parameters<NonNullable<Socket["_writev"]>>) {
    if (active && this.localPort === port) {
      nativeWritev.calls++;
      nativeWritev.chunks += args[0].length;
      for (const { chunk } of args[0]) {
        nativeWritev.bytes += countBytes(chunk);
      }
    }
    return writev.apply(this, args);
  };
  // Diagnostics setup and its acknowledgment are synchronous in the profile owner.
  process.prependListener("message", (message: GatewayBenchCommand) => {
    if (message?.channel !== GATEWAY_PROFILE_CHANNEL || message.kind !== "diagnostics") {
      return;
    }
    if (message.action === "start") {
      concat = {};
      nativeWrite = { calls: 0, bytes: 0 };
      nativeWritev = { calls: 0, bytes: 0, chunks: 0 };
      queueMicrotask(() => {
        active = true;
      });
    } else {
      active = false;
      writeFileSync(
        output,
        JSON.stringify({
          scope: "Gateway main-isolate concat calls; native socket submissions on the Gateway port",
          concat,
          nativeWrite,
          nativeWritev,
        }),
      );
    }
  });
}
