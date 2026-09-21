#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, fork, spawnSync } from "node:child_process";
// Package proof: relocation, native load dependencies, provenance, and actual
// JSONL worker readiness. Never admits or opens the operator's live state.
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  seedMacNodeWorkerProofState,
  readMacNodeWorkerProofRows,
} from "./lib/mac-node-worker-proof-state.mjs";
import { auditMacWorkerPortability } from "./lib/mac-worker-portability.mjs";
import { runManagedCommand, terminateManagedChild } from "./lib/managed-child-process.mts";

const [runtimeArg, expectedInfoPath] = process.argv.slice(2);
if (!runtimeArg || !expectedInfoPath) {
  throw new Error("Usage: verify-mac-node-worker.mjs <runtime> <expected-build-info.json>");
}
const runtime = fs.realpathSync(runtimeArg);
const node = path.join(runtime, "bin/node");
const packageRoot = path.join(runtime, "lib/node_modules/openclaw");
if (fs.existsSync(path.join(packageRoot, "dist/control-ui"))) {
  throw new Error("Private worker must not contain Gateway Control UI assets");
}
const expected = JSON.parse(fs.readFileSync(expectedInfoPath, "utf8"));
const actual = JSON.parse(fs.readFileSync(path.join(packageRoot, "dist/build-info.json"), "utf8"));
for (const key of ["version", "commit", "builtAt", "buildId"]) {
  if (!expected[key] || expected[key] !== actual[key]) {
    throw new Error(`Private worker build mismatch: ${key}`);
  }
}
if (fs.realpathSync(process.execPath) !== node) {
  throw new Error("Worker proof must execute the bundled Node for the requested architecture");
}

const nativeFiles = auditMacWorkerPortability(runtime, node);

async function proveServiceChildRuntime(home) {
  const relayPath = path.join(packageRoot, "dist/process/supervisor/service-child-relay.js");
  const anchorPath = path.join(
    packageRoot,
    "dist/process/supervisor/service-child-group-anchor.js",
  );
  assert(fs.existsSync(anchorPath), "Bundled service-child group anchor is missing");
  await new Promise((resolve, reject) => {
    const child = fork(relayPath, [], {
      cwd: home,
      env: { ...process.env, HOME: home, TMPDIR: home },
      execPath: node,
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe", "ipc"],
    });
    const control = child.stdio[3];
    const lineage = child.stdio[4];
    let controlBuffer = "";
    let output = "";
    let rootSucceeded = false;
    let closed = false;
    let hostSequence = 0;
    let lineageReported = false;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Bundled service-child relay proof timed out"));
    }, 20_000);
    const fail = (error) => {
      if (closed) {
        return;
      }
      closed = true;
      clearTimeout(timeout);
      child.kill("SIGKILL");
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    child.on("error", fail);
    child.on("message", (message) => {
      if (message?.type === "relay-error") {
        fail(new Error(`Bundled service-child relay failed: ${message.error}`));
      }
    });
    control.on("data", (chunk) => {
      controlBuffer += chunk.toString();
      for (;;) {
        const newline = controlBuffer.indexOf("\n");
        if (newline < 0) {
          break;
        }
        const line = controlBuffer.slice(0, newline);
        controlBuffer = controlBuffer.slice(newline + 1);
        const message = JSON.parse(line);
        if (message.type === "root-result") {
          rootSucceeded = message.code === 0 && message.signal === null;
        } else if (message.type === "closing") {
          control.write(
            `${JSON.stringify({
              type: "closing-ack",
              generation: message.generation,
              sequence: ++hostSequence,
              closingSequence: message.sequence,
            })}\n`,
          );
        }
      }
    });
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    control.on("error", fail);
    lineage.on("error", fail);
    const reportLineageClosed = () => {
      if (lineageReported) {
        return;
      }
      lineageReported = true;
      control.write(
        `${JSON.stringify({
          type: "lineage-closed",
          generation: "mac-worker-relay-proof",
          sequence: ++hostSequence,
        })}\n`,
      );
    };
    lineage.once("end", reportLineageClosed);
    lineage.once("close", reportLineageClosed);
    child.once("spawn", () => {
      child.send({
        type: "start",
        generation: "mac-worker-relay-proof",
        command: node,
        args: ["-e", 'process.stdout.write("mcp-relay-proof")'],
        cwd: home,
        env: Object.fromEntries(
          Object.entries({ ...process.env, HOME: home, TMPDIR: home }).filter(
            (entry) => entry[1] !== undefined,
          ),
        ),
        stdinMode: "pipe-closed",
        controlFd: 3,
        lineageFd: 4,
        acknowledgeClosing: true,
      });
    });
    child.once("exit", (code, signal) => {
      if (closed) {
        return;
      }
      closed = true;
      clearTimeout(timeout);
      if (code === 0 && signal === null && rootSucceeded && output === "mcp-relay-proof") {
        resolve();
      } else {
        reject(
          new Error(
            `Bundled service-child relay proof failed (${code}/${signal}): ${JSON.stringify(output)}`,
          ),
        );
      }
    });
  });
}

async function proveGitWorkerRuntime(home) {
  const repository = path.join(home, "git-worker-proof");
  fs.mkdirSync(repository);
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "proof@openclaw.invalid"],
    ["config", "user.name", "OpenClaw Proof"],
  ]) {
    execFileSync("git", args, { cwd: repository });
  }
  fs.writeFileSync(path.join(repository, "proof.txt"), "before\n");
  execFileSync("git", ["add", "proof.txt"], { cwd: repository });
  execFileSync("git", ["commit", "-qm", "proof"], { cwd: repository });
  fs.writeFileSync(path.join(repository, "proof.txt"), "after\n");
  const { WorkerTaskPool } = await import(
    pathToFileURL(path.join(packageRoot, "dist/plugin-sdk/process-runtime.js")).href
  );
  const pool = new WorkerTaskPool({
    workerUrl: pathToFileURL(path.join(packageRoot, "dist/infra/git-operation.worker.js")),
    maxWorkers: 1,
    idleTimeoutMs: 1_000,
  });
  try {
    const reply = await pool.run(
      { type: "checkout.diff", input: { cwd: repository, scope: "uncommitted" } },
      {
        timeoutMs: 30_000,
        onRequest: async (request) => {
          assert.equal(request?.type, "git.batch");
          const replies = request.input.requests.map((operation) => {
            assert(operation.type === "git.text" || operation.type === "git.buffer");
            const result = spawnSync("git", ["-C", operation.input.cwd, ...operation.input.args], {
              env: { ...process.env, ...operation.input.options.env },
              input: operation.input.options.input,
              encoding: null,
            });
            return {
              ok: true,
              value: {
                stdout: new Uint8Array(result.stdout ?? Buffer.alloc(0)),
                stderr: new Uint8Array(result.stderr ?? Buffer.alloc(0)),
                windowsEncoding: null,
                code: result.status,
                signal: result.signal,
                killed: false,
                cleanup: "normal",
                termination: result.signal ? "signal" : "exit",
                timeoutMs: 30_000,
              },
            };
          });
          return { input: replies, timeoutMs: 30_000 };
        },
      },
    );
    assert(reply.ok, `Bundled Git worker failed: ${JSON.stringify(reply.error)}`);
    assert(reply.value.files.some((file) => file.path === "proof.txt"));
  } finally {
    await pool.close();
  }
}

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-worker-proof-")));
try {
  // Ready manifests do not load lazy native capabilities. Exercise their real
  // package loaders so omitted optional packages and wrong slices fail staging.
  const require = createRequire(path.join(packageRoot, "package.json"));
  // Keep required native mode and bundled module identity in a fresh process;
  // worker readiness below must still use OpenClaw's normal defaults.
  execFileSync(
    node,
    [fileURLToPath(new URL("./verify-mac-node-worker-fs.mjs", import.meta.url)), packageRoot, home],
    {
      cwd: home,
      env: { HOME: home, TMPDIR: home, FS_SAFE_NATIVE_MODE: "require" },
      stdio: "inherit",
    },
  );
  const database = new DatabaseSync(":memory:", { allowExtension: true });
  try {
    require("sqlite-vec").load(database);
    assert.equal(
      typeof database.prepare("SELECT vec_version() AS version").get().version,
      "string",
    );
  } finally {
    database.close();
  }
  await new Promise((resolve, reject) => {
    const terminal = require("@lydell/node-pty").spawn(
      "/bin/sh",
      ["-c", "printf worker-pty-proof"],
      {
        cwd: home,
        env: { HOME: home, PATH: "/usr/bin:/bin" },
        name: "xterm",
        cols: 80,
        rows: 24,
      },
    );
    let output = "";
    const timeout = setTimeout(() => {
      terminal.kill("SIGKILL");
      reject(new Error("Bundled PTY did not exit"));
    }, 10_000);
    terminal.onData((data) => {
      output += data;
    });
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      if (exitCode === 0 && output === "worker-pty-proof") {
        resolve();
      } else {
        reject(new Error(`Bundled PTY failed (${exitCode}): ${output}`));
      }
    });
  });
  // Browser screenshot normalization reaches this SDK helper, which launches a
  // worker by its declared runtime path rather than through a module import.
  const { resizeToJpeg } = await import(
    pathToFileURL(path.join(packageRoot, "dist/plugin-sdk/media-runtime.js")).href
  );
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=",
    "base64",
  );
  const jpeg = await resizeToJpeg({ buffer: png, maxSide: 1, quality: 80 });
  assert.deepEqual(jpeg.subarray(0, 2), Buffer.from([0xff, 0xd8]));
  // The retained SQLite SDK launches its store host through another declared
  // runtime path. Prove a real create/write/read/close cycle after relocation.
  const sqliteBackendPath = path.join(home, "sqlite-worker-proof-backend.mjs");
  fs.writeFileSync(
    sqliteBackendPath,
    `
import { DatabaseSync } from "node:sqlite";
export function createSqliteWorkerBackend(_input, { databasePath }) {
  const database = new DatabaseSync(databasePath);
  return {
    execute(command) {
      if (command.type === "roundTrip") {
        return database.prepare("SELECT ? AS value").get(command.input).value;
      }
      throw new Error("Unexpected SQLite worker proof command");
    },
    close() {
      database.close();
    },
  };
}
`,
  );
  const { openSqliteWorkerStore } = await import(
    pathToFileURL(path.join(packageRoot, "dist/plugin-sdk/sqlite-runtime.js")).href
  );
  const sqliteStore = await openSqliteWorkerStore({
    moduleUrl: pathToFileURL(sqliteBackendPath),
    databasePath: path.join(home, "sqlite-worker-proof.sqlite"),
    input: undefined,
  });
  try {
    assert.equal(
      await sqliteStore.execute({ type: "roundTrip", input: "sqlite-worker-proof" }),
      "sqlite-worker-proof",
    );
  } finally {
    await sqliteStore.close();
  }
  // Configured stdio MCP servers and hosted-workspace diffs both reach helpers
  // through runtime descriptors. Execute those relocated process boundaries so
  // a present-but-incomplete closure fails before the app is signed.
  await proveServiceChildRuntime(home);
  await proveGitWorkerRuntime(home);
  for (const { nativeFirst, desktopSharingEnabled } of [false, true].flatMap((nativeFirstEnabled) =>
    [undefined, true, false].map((sharingEnabled) => ({
      nativeFirst: nativeFirstEnabled,
      desktopSharingEnabled: sharingEnabled,
    })),
  )) {
    const appGatedComputer = !nativeFirst;
    const proofHome = path.join(
      home,
      `${nativeFirst ? "native-first" : "absent"}-${desktopSharingEnabled ?? "default"}`,
    );
    const stateDir = path.join(proofHome, "state");
    const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
    fs.mkdirSync(proofHome, { recursive: true });
    // State lifecycle coordination lives outside removable state. Only remove
    // this fresh fixture's exact hashes after the complete worker tree exits.
    const coordinatorHash = createHash("sha256").update(databasePath).digest("hex").slice(0, 8);
    const coordinatorFiles = ["state-lifecycle", "gateway-lifecycle"].flatMap((family) => {
      const file = path.join(
        fs.realpathSync("/tmp"),
        `openclaw-state-locks-${process.getuid()}`,
        `${family}.${coordinatorHash}.lock.sqlite`,
      );
      return [file, `${file}-journal`, `${file}-wal`, `${file}-shm`];
    });
    assert(
      coordinatorFiles.every((file) => !fs.existsSync(file)),
      "Proof coordinator already exists",
    );
    const nativeRows = nativeFirst ? seedMacNodeWorkerProofState(databasePath) : undefined;
    let ready = false;
    let failure;
    let diagnostic = "";
    const exitCode = await runManagedCommand({
      bin: node,
      args: [
        path.join(packageRoot, "dist/mac-node-worker.js"),
        ...(nativeFirst ? ["--profile", "mac-worker-proof"] : []),
        "node",
        "worker",
        ...(desktopSharingEnabled === undefined
          ? []
          : [desktopSharingEnabled ? "--desktop-sharing" : "--no-desktop-sharing"]),
      ],
      cwd: proofHome,
      env: {
        HOME: proofHome,
        TMPDIR: proofHome,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(proofHome, "openclaw.json"),
        PATH: `${path.dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin`,
        OPENCLAW_NODE_EXEC_HOST: "app",
        OPENCLAW_NODE_EXEC_FALLBACK: "0",
        ...(appGatedComputer
          ? {
              // Match the Mac app's synchronous readiness lease so the proof verifies
              // that the bundled CUA plugin registers its computer-control commands.
              OPENCLAW_CUA_DRIVER_ENDPOINT: JSON.stringify({
                v: 1,
                socketPath: path.join(proofHome, "cua-driver.sock"),
                binaryPath: "/usr/bin/true",
              }),
            }
          : {}),
        // Same launch shape as MacNodeHostWorker: the worker must stay in the owned
        // process group, or requireProcessTreeExit only proves the respawn wrapper died.
        OPENCLAW_NO_RESPAWN: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
      timeoutMs: 300_000,
      requireProcessTreeExit: true,
      onReady(child) {
        const lines = createInterface({ input: child.stdout });
        child.stderr.on("data", (data) => {
          diagnostic = (diagnostic + data.toString()).slice(0, 4000);
        });
        lines.on("line", (line) => {
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            return;
          }
          if (message.type !== "ready") {
            return;
          }
          if (
            message.version !== expected.version ||
            !message.manifest?.commands?.includes("system.run") ||
            !message.manifest?.commands?.includes("system.which") ||
            !message.manifest?.commands?.includes("browser.proxy") ||
            !message.manifest?.commands?.includes("browser.proxy.upload.v1") ||
            !message.manifest?.commands?.includes("mcp.tools.call.v1") ||
            (desktopSharingEnabled !== undefined &&
              message.manifest?.commands?.includes("desktop.stream") !== desktopSharingEnabled) ||
            (appGatedComputer &&
              (!message.manifest?.commands?.includes("screen.snapshot") ||
                !message.manifest?.commands?.includes("computer.act")))
          ) {
            failure = new Error(
              `Bundled worker returned an incompatible capability manifest: ${JSON.stringify(message.manifest)}`,
            );
            child.stdin.end('{"type":"stop"}\n');
            return;
          }
          ready = true;
          process.stdout.write(
            `${JSON.stringify({ architecture: process.arch, nativeFirst, desktopSharingEnabled, build: actual, nativeFiles, databasePath, manifest: message.manifest })}\n`,
          );
          if (appGatedComputer) {
            // The readiness lease uses a harmless executable, not a live MCP
            // daemon. Kill this capability probe before provider cleanup tries
            // to contact it; the second lane still proves graceful shutdown.
            terminateManagedChild(child, "SIGKILL");
          } else {
            child.stdin.end('{"type":"stop"}\n');
          }
        });
        child.on("close", () => lines.close());
        child.stdin.on("error", (error) => {
          failure = error;
          terminateManagedChild(child, "SIGKILL");
        });
      },
    });
    for (const file of coordinatorFiles) {
      fs.rmSync(file, { force: true });
    }
    const expectedExitCode = appGatedComputer ? 137 : 0;
    if (
      failure ||
      !ready ||
      exitCode !== expectedExitCode ||
      /failed during register/u.test(diagnostic)
    ) {
      throw new Error(
        `Bundled worker proof failed (${exitCode}): ${failure?.message ?? "missing readiness or registration failure"}; ${diagnostic}`,
        { cause: failure },
      );
    }
    if (nativeRows) {
      const initialized = new DatabaseSync(databasePath, { readOnly: true });
      try {
        assert.deepEqual(readMacNodeWorkerProofRows(initialized), nativeRows);
      } finally {
        initialized.close();
      }
    }
  }
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
