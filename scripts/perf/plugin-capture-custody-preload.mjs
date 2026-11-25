// Synthetic operation-completion delay; never load this in a real Gateway.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { isMainThread, threadId } from "node:worker_threads";

export function installCaptureCreateProbe(target, delayMs, armPath) {
  if (
    !["source", "native", "recovery"].includes(target) ||
    !Number.isFinite(delayMs) ||
    delayMs <= 0
  ) {
    throw new Error("Capture preload requires source/native/recovery kind and positive delayMs");
  }
  const probes = [];
  const create = fs.mkdtempSync;
  let delayed = false;
  fs.mkdtempSync = function (...args) {
    // Only successful creates count: native admission first probes a missing payload directory.
    const directory = Reflect.apply(create, fs, args);
    const prefix = typeof args[0] === "string" ? path.basename(args[0]) : "";
    const kind =
      prefix === "plugin-preparation-"
        ? "source"
        : prefix === "admission-" && path.basename(path.dirname(args[0])) === "native"
          ? "native"
          : prefix === "openclaw-plugin-build-"
            ? "recovery"
            : undefined;
    if (kind) {
      const startedAtMs = Date.now();
      const held = kind === target && !delayed && (!armPath || fs.existsSync(armPath));
      if (held) {
        delayed = true;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
      }
      const probe = {
        api: "mkdtempSync",
        kind,
        pid: process.pid,
        threadId,
        isMainThread,
        held,
        startedAtMs,
        endedAtMs: Date.now(),
        directory: String(directory),
      };
      probes.push(probe);
      process.stderr.write(`CAPTURE_CREATE_PROBE ${JSON.stringify(probe)}\n`);
    }
    return directory;
  };
  syncBuiltinESMExports();
  return probes;
}

const parameters = new URL(import.meta.url).searchParams;
if (parameters.size > 0) {
  installCaptureCreateProbe(
    parameters.get("kind"),
    Number(parameters.get("delayMs")),
    parameters.get("armPath"),
  );
}
