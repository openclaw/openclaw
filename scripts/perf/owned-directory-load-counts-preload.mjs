// Private benchmark preload, enabled only by fixed-duration gateway-concurrency runs.
// Cumulative snapshots bracket the harness's two CPU samples. Counts cover main-thread
// stat calls and native watch deliveries (including the macOS helper's IPC deliveries),
// not worker-thread filesystem calls or consumer invalidation counts. Raw event classes
// matter: macOS can report content writes as rename. Subtract snapshots; divide by elapsed seconds.
import childProcess from "node:child_process";
import fs from "node:fs";
import promises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { isMainThread } from "node:worker_threads";

const output = new URL(import.meta.url).searchParams.get("output");
if (isMainThread && output) {
  const counts = {
    statSync: 0,
    statAsync: 0,
    databaseStats: 0,
    nativeEvents: 0,
    hostedEvents: 0,
    namedChanges: 0,
    renames: 0,
    unclassifiedEvents: 0,
  };
  const recordEvent = (event, filename) => {
    if (event === "change" && filename != null) {
      counts.namedChanges++;
    } else if (event === "rename") {
      counts.renames++;
    } else {
      counts.unclassifiedEvents++;
    }
  };
  const snapshots = [];
  const database = (value) => typeof value === "string" && value.endsWith("openclaw-agent.sqlite");
  const statSync = fs.statSync;
  fs.statSync = function (...args) {
    counts.statSync++;
    if (database(args[0])) {
      counts.databaseStats++;
    }
    return Reflect.apply(statSync, this, args);
  };
  const stat = promises.stat;
  promises.stat = function (...args) {
    counts.statAsync++;
    if (database(args[0])) {
      counts.databaseStats++;
    }
    return Reflect.apply(stat, this, args);
  };
  const watch = fs.watch;
  fs.watch = function (...args) {
    const listenerIndex = args.findLastIndex((arg) => typeof arg === "function");
    if (listenerIndex >= 0) {
      const listener = args[listenerIndex];
      args[listenerIndex] = function (...event) {
        counts.nativeEvents++;
        recordEvent(event[0], event[1]);
        return Reflect.apply(listener, this, event);
      };
    }
    return Reflect.apply(watch, this, args);
  };
  const spawn = childProcess.spawn;
  childProcess.spawn = function (...args) {
    const child = Reflect.apply(spawn, this, args);
    if (
      Array.isArray(args[1]) &&
      args[1].some((arg) => String(arg).includes("directory-watch-host.worker"))
    ) {
      let buffered = "";
      child.stdout?.on("data", (chunk) => {
        const lines = (buffered + chunk).split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          try {
            const message = JSON.parse(line);
            if (message.event) {
              counts.hostedEvents++;
              recordEvent(message.event, message.filename);
            }
          } catch {
            // A failed helper reports through its owning listener, not instrumentation.
          }
        }
      });
    }
    return child;
  };
  syncBuiltinESMExports();
  process.on("message", (message) => {
    if (message?.channel === "openclaw-gateway-bench-profile" && message.kind === "cpu-usage") {
      snapshots.push({ atMs: performance.now(), ...counts });
      fs.writeFileSync(
        output,
        JSON.stringify(
          { scope: "main-thread; watcher host deliveries included", snapshots },
          null,
          2,
        ),
      );
    }
  });
}
