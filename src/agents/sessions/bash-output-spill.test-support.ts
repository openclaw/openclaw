import { execFile, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { hasErrnoCode } from "../../infra/errno.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { isPidAlive } from "../../shared/pid-alive.js";
import { createNodeEvalArgs, resolveTestNodeExecPath } from "../../test-utils/node-process.js";
import { bashOutputSpillEntrypoints } from "./bash-output-spill-entrypoints.test-support.js";

export const nativeBashSpillScenarios = ["fault-large", "writable-large", "fault-small"] as const;

const producerSource = String.raw`
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
const [control, size, tracePath, releasePort] = process.argv.slice(2);
let traceCount = 0;
function trace(phase, fields = {}) {
  const line = JSON.stringify({ actor: "producer", phase, at: Date.now(), ...fields }) + "\n";
  assert(++traceCount <= 32 && Buffer.byteLength(line) <= 512, "producer trace exceeded bound");
  fs.appendFileSync(tracePath, line);
}
let written = false;
let finished = false;
let released = false;
function advance() {
  if (!written || finished || !released) return;
  finished = true;
  trace("release-observed");
  trace("final-write-started");
  process.stdout.write("FINAL: preserve Ω🙂\n", () => {
    fs.writeFileSync(path.join(control, "completed"), "completed");
    trace("completed");
  });
}
// The runner owns release; its connection also ends a stranded producer if it exits.
const release = net.createConnection({ host: "127.0.0.1", port: Number(releasePort) });
release.once("data", () => { released = true; advance(); });
release.once("end", () => { if (!released) process.exit(93); });
release.once("error", () => process.exit(93));
const pgid = Number(execFileSync("/bin/ps", ["-p", String(process.pid), "-o", "pgid="], {
  encoding: "utf8", timeout: 1000, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
}).trim());
assert.equal(pgid, process.pid);
fs.writeFileSync(path.join(control, "producer.json"), JSON.stringify({
  pid: process.pid, ppid: process.ppid, pgid, control,
}), { flag: "wx", mode: 0o600 });
trace("ready", { pid: process.pid, ppid: process.ppid, pgid });
const prefix = size === "large" ? "BEGIN:large\n" + "x".repeat(60 * 1024) + "\n" : "BEGIN:small\n";
trace("prefix-write-started", { bytes: Buffer.byteLength(prefix) });
process.stdout.write(prefix, () => { written = true; trace("prefix-written"); advance(); });
`;

const caseSource = String.raw`
import assert from "node:assert/strict";
import { errorMonitor } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
const { root, tracePath, entrypoint, scenario, toolUrl, executorUrl, startedAt } = fixture;
const controller = new AbortController();
process.stdin.once("data", () => controller.abort());
let traceCount = 0;
function trace(phase, fields = {}) {
  const line = JSON.stringify({ actor: "runner", phase, at: Date.now(), ...fields }) + "\n";
  assert(++traceCount <= 32 && Buffer.byteLength(line) <= 512, "runner trace exceeded bound");
  fs.appendFileSync(tracePath, line);
}
trace("runner-started", { startedAt });
const { createBashTool, createLocalBashOperations } = await import(toolUrl);
const { executeBashWithOperations } = await import(executorUrl);
trace("imports-ready");
assert.equal(process.listenerCount("uncaughtException"), 0);
assert.equal(process.listenerCount("unhandledRejection"), 0);
assert.equal(process.hasUncaughtExceptionCaptureCallback(), false);
const fault = scenario.startsWith("fault");
const small = scenario.endsWith("small");
const spillRoot = path.join(root, fault ? "missing" : "spill");
if (!fault) fs.mkdirSync(spillRoot, { mode: 0o700 });
process.env.TMPDIR = process.env.TMP = process.env.TEMP = spillRoot;
assert.equal(os.tmpdir(), spillRoot);
assert.equal(fs.existsSync(spillRoot), !fault);
let released = false;
let releaseSocket;
const releaseServer = net.createServer((socket) => {
  releaseSocket = socket;
  if (released) socket.end("release");
});
await new Promise((resolve) => releaseServer.listen(0, "127.0.0.1", resolve));
const releasePort = releaseServer.address().port;
let settled = false;
let nativeError;
let observerFailed = false;
let creations = 0;
let prefix = "";
let payloadObserved = false;
function release() {
  if (released) return;
  fs.writeFileSync(path.join(root, "release"), "release", { flag: "wx", mode: 0o600 });
  released = true;
  trace("release-created");
  releaseSocket?.end("release");
}
function observe(action) {
  // A receipt failure must not replace the native stream error under test.
  try { action(); } catch { observerFailed = true; }
}
function producerAlive() {
  const producer = JSON.parse(fs.readFileSync(path.join(root, "producer.json"), "utf8"));
  assert.equal(producer.control, root);
  assert.equal(producer.ppid, process.pid);
  assert.equal(producer.pgid, producer.pid);
  process.kill(producer.pid, 0);
  assert.equal(settled, false);
  return producer.pid;
}
function onText(text) {
  if (text && !payloadObserved) {
    const producerPid = producerAlive();
    assert(Date.now() - startedAt < 20_000, "producer receipt exceeded child deadline");
    payloadObserved = true;
    trace("payload-observed", { producerPid });
  }
  prefix = (prefix + text).slice(-64);
  if (small && prefix.includes("BEGIN:small")) release();
}
const createWriteStream = fs.createWriteStream;
fs.createWriteStream = function (...args) {
  const stream = Reflect.apply(createWriteStream, this, args);
  creations++;
  observe(() => {
    assert(stream instanceof fs.WriteStream);
    assert.equal(path.dirname(String(args[0])), spillRoot);
    trace("stream-created", { creations, settled });
  });
  stream.once(errorMonitor, (error) => observe(() => {
    nativeError = error;
    const producerPid = producerAlive();
    trace("native-error", { code: error.code, syscall: error.syscall, producerPid, settled });
    release();
    console.log(JSON.stringify({ phase: "native-error", code: error.code, syscall: error.syscall,
      producerPid, settled, observerFailed }));
  }));
  if (!fault) stream.once("open", () => observe(() => {
    trace("stream-open", { producerPid: producerAlive(), settled });
    release();
  }));
  return stream;
};
syncBuiltinESMExports();
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const command = "exec " + quote(process.execPath) + " " + quote(path.join(root, "producer.mjs")) +
  " " + quote(root) + " " + (small ? "small" : "large") + " " + quote(tracePath) + " " + releasePort;
try {
  let result;
  let rejection;
  trace("call-started");
  try {
    result = entrypoint === "tool"
      ? await createBashTool(root, { shellPath: "/bin/bash" }).execute("native-spill", { command }, controller.signal,
          (update) => onText(update.content.filter((block) => block.type === "text").map((block) => block.text).join("")))
      : await executeBashWithOperations(command, root, createLocalBashOperations({ shellPath: "/bin/bash" }), { onChunk: onText, signal: controller.signal });
  } catch (error) { rejection = error; }
  settled = true;
  trace("call-settled", { rejected: rejection !== undefined, observerFailed, creations });
  assert.equal(observerFailed, false);
  assert.equal(payloadObserved, true);
  assert.equal(fs.existsSync(path.join(root, "release")), true);
  assert.equal(fs.existsSync(path.join(root, "completed")), true);
  if (fault && !small) {
    assert.equal(nativeError?.code, "ENOENT");
    assert.equal(nativeError.syscall, "open");
    assert.equal(path.dirname(nativeError.path), spillRoot);
    assert.equal(rejection, nativeError);
    assert.equal(result, undefined);
  } else {
    assert.equal(rejection, undefined);
    assert.equal(nativeError, undefined);
    const text = entrypoint === "tool" ? result.content.filter((block) => block.type === "text").map((block) => block.text).join("") : result.output;
    const fullOutputPath = entrypoint === "tool" ? result.details?.fullOutputPath : result.fullOutputPath;
    if (small) {
      assert.equal(creations, 0);
      assert.equal(fullOutputPath, undefined);
      assert.equal(text, "BEGIN:small\nFINAL: preserve Ω🙂\n");
      if (entrypoint === "tool") assert.equal(result.details?.truncation, undefined);
      else assert.equal(result.truncated, false);
    } else {
      assert.equal(path.dirname(fullOutputPath), spillRoot);
      assert.equal(fs.readFileSync(fullOutputPath, "utf8"), "BEGIN:large\n" + "x".repeat(60 * 1024) + "\nFINAL: preserve Ω🙂\n");
      assert.equal(fs.statSync(fullOutputPath).mode & 0o777, 0o600);
      if (entrypoint === "tool") {
        const footer = text.indexOf("\n\n[Showing ");
        assert(footer >= 0);
        assert.equal(text.slice(0, footer), "FINAL: preserve Ω🙂");
        assert(text.includes("Full output: " + fullOutputPath));
        assert.equal(result.details.truncation.truncated, true);
        assert(result.details.truncation.outputBytes <= 50 * 1024);
      } else {
        assert.equal(text, "FINAL: preserve Ω🙂");
        assert.equal(result.truncated, true);
        assert.equal(result.exitCode, 0);
        assert(Buffer.byteLength(text) <= 50 * 1024);
      }
    }
  }
  console.log("native Bash spill case passed");
} finally {
  fs.createWriteStream = createWriteStream;
  syncBuiltinESMExports();
  releaseSocket?.destroy();
  await new Promise((resolve, reject) => releaseServer.close((error) => error ? reject(error) : resolve()));
  process.stdin.destroy();
}
`;

type RunnerResult = { error: Error | undefined; stdout: string; stderr: string };

export async function expectNativeBashSpill(
  entrypoint: "tool" | "executor",
  scenario: (typeof nativeBashSpillScenarios)[number],
  signal: AbortSignal,
): Promise<void> {
  // Detached producers must outlive neither their fixture nor its cleanup proof.
  // Keep failure evidence outside the runner's auto-cleaned oc-vt namespace.
  const artifactRoot = fileURLToPath(new URL("../../../.local/", import.meta.url));
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  const root = await realpath(await mkdtemp(join(artifactRoot, "bash-spill-test-")));
  const tracePath = `${root}.trace`;
  let producerStopped = false;
  let producerPid: number | undefined;
  let runner: ChildProcess | undefined;
  let runnerCompletion: Promise<RunnerResult> | undefined;
  let childResult: RunnerResult | undefined;
  let elapsedMs: number | undefined;
  const diagnostics = async () => ({
    entrypoint,
    scenario,
    fixture: root,
    status: runner?.exitCode,
    signal: runner?.signalCode,
    spawnError: childResult?.error?.message,
    elapsedMs,
    stdout: childResult?.stdout,
    stderr: childResult?.stderr,
    trace: await readFile(tracePath, "utf8").catch(() => "trace unavailable"),
  });
  try {
    await writeFile(tracePath, "", { flag: "wx", mode: 0o600 });
    await writeFile(join(root, "producer.mjs"), producerSource, { mode: 0o600 });
    const toolUrl = resolveRuntimeWorkerUrl(bashOutputSpillEntrypoints.tool);
    const executorUrl = resolveRuntimeWorkerUrl(bashOutputSpillEntrypoints.executor);
    const nodeExecPath = resolveTestNodeExecPath();
    const startedAt = Date.now();
    const fixture = {
      root,
      tracePath,
      entrypoint,
      scenario,
      startedAt,
      toolUrl: toolUrl.href,
      executorUrl: executorUrl.href,
    };
    const completion = createDeferred<RunnerResult>();
    runnerCompletion = completion.promise;
    runner = execFile(
      nodeExecPath,
      [
        ...resolveRuntimeWorkerArgv(toolUrl, nodeExecPath).slice(0, -1),
        ...createNodeEvalArgs(`const fixture = ${JSON.stringify(fixture)};\n${caseSource}`),
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 20_000,
        maxBuffer: 64 * 1024,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          USERPROFILE: root,
          TMPDIR: root,
          TMP: root,
          TEMP: root,
          OPENCLAW_STATE_DIR: join(root, "state"),
          OPENCLAW_OFFLINE: "1",
          NODE_DISABLE_COMPILE_CACHE: "1",
          TSX_DISABLE_CACHE: "1",
        },
      },
      (error, stdout, stderr) => {
        elapsedMs = Date.now() - startedAt;
        childResult = { error: error ?? undefined, stdout, stderr };
        completion.resolve(childResult);
      },
    );
    runner.stdin?.on("error", () => {});
    const result = await withinTest(runnerCompletion, signal);
    const producer = JSON.parse(
      await readFile(join(root, "producer.json"), "utf8").catch((error: unknown) => {
        throw new Error(
          `Missing producer receipt after child status ${runner?.exitCode}: ${result.stderr}`,
          { cause: error },
        );
      }),
    );
    expect(producer.control).toBe(root);
    expect(producer.ppid).toBe(runner.pid);
    expect(Number.isSafeInteger(producer.pid) && producer.pid > 0).toBe(true);
    expect(producer.pgid).toBe(producer.pid);
    producerPid = producer.pid;
    // The closed runner owns no child handle for its detached producer. Its IPC
    // connection has closed; only foreign PID/group extinction remains to observe.
    for (;;) {
      try {
        process.kill(-producer.pgid, 0);
      } catch (error) {
        if (!hasErrnoCode(error, "ESRCH")) {
          throw error;
        }
        if (!isPidAlive(producer.pid)) {
          break;
        }
      }
      await delay(10, undefined, { signal }).catch((error: unknown) => {
        throw new Error("Timed out waiting for Bash producer PID and group to exit", {
          cause: error,
        });
      });
    }
    expect(isPidAlive(producer.pid)).toBe(false);
    expect(() => process.kill(-producer.pgid, 0)).toThrowError(
      expect.objectContaining({ code: "ESRCH" }),
    );
    producerStopped = true;
    console.log(JSON.stringify(await diagnostics()));
    expect(result.error).toBeUndefined();
    expect(runner.signalCode).toBeNull();
    expect(runner.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("native Bash spill case passed");
  } catch (error) {
    throw new Error(JSON.stringify(await diagnostics()), { cause: error });
  } finally {
    // Ask the fixture to cancel through the product owner, then join its process;
    // killing the runner alone could orphan its detached producer during startup.
    runner?.stdin?.end("abort");
    await runnerCompletion;
    if (!producerStopped && producerPid !== undefined) {
      try {
        process.kill(-producerPid, "SIGKILL");
      } catch (error) {
        if (!hasErrnoCode(error, "ESRCH")) {
          console.error("Bash producer cleanup failed", error);
        }
      }
    }
    // A missing producer receipt or uncertain teardown must retain its files.
    if (producerStopped) {
      await rm(root, { recursive: true, force: true });
      await rm(tracePath, { force: true });
    }
  }
}
