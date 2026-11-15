#!/usr/bin/env node
// Validate the standalone import boundary before loading code as root.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

class InspectionFailure extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

function fail(reason) {
  throw new InspectionFailure(reason);
}

function readStat(filename) {
  try {
    return fs.lstatSync(filename);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw new InspectionFailure("filesystem-inspection-failed");
  }
}

function inspectPath(filename) {
  // A trusted leaf below a writable directory can be replaced before import.
  // Validate the complete path before loading the shared discovery helper.
  const parts = filename.split("/").filter(Boolean);
  let current = "/";
  let result;
  for (const part of ["", ...parts]) {
    current = path.join(current, part);
    result = readStat(current);
    if (!result) {
      fail("required-path-missing");
    }
    if (result.isSymbolicLink()) {
      fail("symbolic-link-needs-owner-inspection");
    }
    if (result.uid !== 0 || (result.mode & 0o022) !== 0) {
      fail("unsafe-path-ownership");
    }
    if (current !== filename && !result.isDirectory()) {
      fail("invalid-path-type");
    }
  }
  return result;
}

function registerExitCleanup(cleanup) {
  const unregister = () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.off("exit", cleanup);
  };
  const onSignal = (signal) => {
    unregister();
    cleanup();
    // This standalone entry point owns its exit policy; preserve signal exit
    // after reclaiming the query instead of continuing with an unknown result.
    process.kill(process.pid, signal);
  };
  const onSigint = () => onSignal("SIGINT");
  const onSigterm = () => onSignal("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  process.once("exit", cleanup);
  return unregister;
}

try {
  if (process.argv.length !== 2) {
    fail("no-arguments-accepted");
  }
  if (process.platform !== "freebsd") {
    fail("freebsd-required");
  }
  if (process.geteuid() !== 0) {
    fail("root-required");
  }
  const discoveryUrl = new URL("./lib/freebsd-service-discovery.mjs", import.meta.url);
  // This small bootstrap cannot import the shared path checker before proving
  // that the helper and every ancestor are root-owned and not writable by others.
  for (const filename of [
    process.execPath,
    path.resolve(process.argv[1]),
    fileURLToPath(discoveryUrl),
  ]) {
    if (!inspectPath(filename).isFile()) {
      fail("invalid-path-type");
    }
  }
  const { discoverFreeBsdService } = await import(discoveryUrl.href);
  const discovered = await discoverFreeBsdService({ registerExitCleanup });
  if (discovered.status === "unknown") {
    fail(discovered.reason);
  }
  const output = JSON.stringify({ ...discovered, authority: "diagnostic-only" });
  if (Buffer.byteLength(output) > 64 * 1024) {
    fail("result-too-large");
  }
  process.stdout.write(`${output}\n`);
} catch (error) {
  const reason = error instanceof InspectionFailure ? error.reason : "inspection-failed";
  process.stdout.write(
    `${JSON.stringify({ schema: 1, service: "openclaw", status: "unknown", reason, authority: "diagnostic-only" })}\n`,
  );
  process.stderr.write(
    `[freebsd-service-inspect] ${reason}. Inspect the service configuration from its owner's root shell.\n`,
  );
  process.stderr.write("[freebsd-service-inspect] FAILED (exit 1)\n");
  process.exitCode = 1;
}
