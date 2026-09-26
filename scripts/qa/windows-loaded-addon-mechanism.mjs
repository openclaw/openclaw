#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  hasUnjoinedWork,
  inspectManagedProcessGroup,
  runManagedCommand,
} from "../lib/managed-child-process.mts";

const addonSha256 = "939156f310bd7a7d9d1db1b5249a5d135739b049c24c79fd3c201701333ddbf3";
const timeoutMs = 60_000;
const childPath = fileURLToPath(new URL("./observe-loaded-addon-removal.cjs", import.meta.url));
const hashFile = async (file) =>
  createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");
const describeError = (/** @type {unknown} */ error) => ({
  name: error instanceof Error ? error.name : "Error",
  code:
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined,
  message: error instanceof Error ? error.message : String(error),
});

async function runCell(mode, source, evidenceDir) {
  const temporaryRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-addon-owner-")),
  );
  const evidencePath = path.join(evidenceDir, `${mode}.json`);
  const receipt = {
    mode,
    timeoutMs,
    temporaryRoot,
    startedAtMs: Date.now(),
    interpretation: "Standalone loaded-addon mechanism; not installed-upgrade qualification",
  };
  try {
    await fs.writeFile(evidencePath, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  } catch (error) {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
  const stdout = [];
  const stderr = [];
  let child;
  let failure;
  const started = performance.now();
  try {
    receipt.commandExitCode = await runManagedCommand({
      bin: process.execPath,
      args: [childPath, mode, source],
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeoutMs,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) =>
              !["TEMP", "TMP", "TMPDIR", "NODE_OPTIONS", "NODE_PATH"].includes(key.toUpperCase()),
          ),
        ),
        TEMP: temporaryRoot,
        TMP: temporaryRoot,
        TMPDIR: temporaryRoot,
      },
      onReady(launched) {
        child = launched;
        receipt.launcherPid = launched.pid;
        launched.on("message", (message) => {
          if (message?.type === "spawned" && Number.isSafeInteger(message.pid)) {
            receipt.commandPid = message.pid;
          }
        });
        launched.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
        launched.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
        launched.once("exit", (code, signal) => {
          receipt.exit = { code, signal, atMs: Date.now() };
          receipt.treeAtExit = inspectManagedProcessGroup(launched, {
            errorPolicy: "indeterminate",
          });
        });
        launched.once("close", () => {
          receipt.closeAtMs = Date.now();
        });
      },
    });
  } catch (error) {
    failure = error;
    receipt.commandFailure = describeError(error);
  }
  receipt.elapsedMs = performance.now() - started;
  receipt.cutoff = failure?.code === "ETIMEDOUT" ? true : failure ? null : false;
  receipt.joined = Boolean(
    child &&
    inspectManagedProcessGroup(child, { errorPolicy: "indeterminate" }) === "dead" &&
    !hasUnjoinedWork(failure),
  );
  const output = Buffer.concat(stdout).toString("utf8");
  try {
    receipt.events = output
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const [created, result] = receipt.events;
    assert.equal(receipt.events.length, 2);
    assert.equal(created.event, "created");
    assert.equal(result.event, "result");
    assert.equal(created.mode, mode);
    assert.equal(result.mode, mode);
    assert.equal(created.sha256, addonSha256);
    assert.equal(result.sha256, addonSha256);
    assert.equal(path.resolve(result.root), path.resolve(created.root));
    assert.equal(path.dirname(path.resolve(created.root)), path.resolve(temporaryRoot));
    assert.ok(path.basename(created.root).startsWith("openclaw-loaded-addon-mechanism-"));
    assert.equal(result.node, "v26.8.2");
    assert.equal(result.modulePresent, mode === "loaded");
    if (mode === "loaded") {
      assert.equal(
        path.toNamespacedPath(path.resolve(result.modulePath)).toLowerCase(),
        path.toNamespacedPath(path.join(path.resolve(created.root), "koffi.node")).toLowerCase(),
      );
    }
    receipt.modulePath = result.modulePath ?? null;
    receipt.observation = "recorded";
  } catch (error) {
    receipt.observation = "inconclusive";
    receipt.observationFailure = describeError(error);
  }
  if (receipt.joined) {
    try {
      await fs.rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await assert.rejects(fs.lstat(temporaryRoot), { code: "ENOENT" });
      receipt.cleanup = { verified: true, atMs: Date.now() };
    } catch (error) {
      receipt.cleanup = { verified: false, failure: describeError(error) };
    }
  } else {
    receipt.cleanup = { verified: false, retained: true, reason: "Command ownership did not join" };
  }
  receipt.completed = Boolean(
    receipt.observation === "recorded" &&
    !failure &&
    receipt.commandExitCode === 0 &&
    receipt.treeAtExit === "dead" &&
    receipt.joined &&
    receipt.cleanup.verified,
  );
  await fs.writeFile(path.join(evidenceDir, `${mode}.stdout.jsonl`), output, { flag: "wx" });
  await fs.writeFile(path.join(evidenceDir, `${mode}.stderr.log`), Buffer.concat(stderr), {
    flag: "wx",
  });
  await fs.writeFile(evidencePath, JSON.stringify(receipt, null, 2) + "\n");
  return receipt;
}

async function main() {
  assert.equal(process.platform, "win32");
  assert.equal(process.arch, "x64");
  assert.equal(process.version, "v26.8.2");
  assert.equal(process.argv.length, 4, "Expected authenticated addon path and evidence directory");
  const source = await fs.realpath(process.argv[2]);
  const evidenceDir = path.resolve(process.argv[3]);
  assert.equal(await hashFile(source), addonSha256);
  await fs.mkdir(evidenceDir, { recursive: true });
  const metadata = {
    node: {
      version: process.version,
      arch: process.arch,
      path: process.execPath,
      sha256: await hashFile(process.execPath),
    },
    source: { path: source, sha256: addonSha256 },
    child: { path: childPath, sha256: await hashFile(childPath) },
    scope: "One unloaded/loaded shallow comparison; no updater execution or qualification",
  };
  await fs.writeFile(
    path.join(evidenceDir, "metadata.json"),
    JSON.stringify(metadata, null, 2) + "\n",
    { flag: "wx" },
  );
  const cells = [];
  for (const mode of ["unloaded", "loaded"]) {
    const cell = await runCell(mode, source, evidenceDir);
    cells.push(cell);
    if (!cell.joined || !cell.cleanup.verified) {
      break;
    }
  }
  const completed = cells.length === 2 && cells.every((cell) => cell.completed);
  await fs.writeFile(
    path.join(evidenceDir, "summary.json"),
    JSON.stringify({ ...metadata, completed, cells }, null, 2) + "\n",
    { flag: "wx" },
  );
  if (!completed) {
    process.exitCode = 1;
  }
}

main().catch((/** @type {unknown} */ error) => {
  process.stderr.write(
    JSON.stringify({ observation: "inconclusive", ...describeError(error) }) + "\n",
  );
  process.exitCode = 1;
});
