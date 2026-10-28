import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import "node:worker_threads";

const require = createRequire(import.meta.url);
const [mode, directory, selectedModule, signal = "SIGTERM", observer = ""] = process.argv.slice(2);
const crablineEntry = import.meta.resolve("@openclaw/crabline");
const modulePath = selectedModule || createRequire(crablineEntry).resolve("proper-lockfile");
const file = path.join(directory, "resource");
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(file, "fixture");

const snapshot = () => ({
  cwd: process.cwd,
  chdir: process.chdir,
  emit: process.emit,
  reallyExit: process.reallyExit,
  close: fs.close,
  closeSync: fs.closeSync,
  prepareStackTrace: Error.prepareStackTrace,
});

const observerDisposers = [];
function addObserver(version, veto = false) {
  const observerPath =
    version === "v3"
      ? createRequire(modulePath).resolve("signal-exit")
      : createRequire(require.resolve("npm/package.json")).resolve("signal-exit");
  const loaded = require(observerPath);
  observerDisposers.push((version === "v3" ? loaded : loaded.onExit)(() => veto));
}
if (observer === "v3-v4-veto") {
  addObserver("v3");
  addObserver("v4", true);
} else if (observer) {
  addObserver(observer === "v3" ? "v3" : "v4", observer.endsWith("veto"));
}

const before = snapshot();
const locks = require(modulePath);

async function compromiseLock(beforeHeartbeat = () => {}) {
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  let heartbeat;
  globalThis.setTimeout = (callback) => {
    heartbeat = callback;
    return { unref() {} };
  };
  globalThis.clearTimeout = () => {};
  try {
    let compromised;
    const failed = new Promise((resolve) => {
      compromised = resolve;
    });
    const compromisedRelease = await locks.lock(file, { onCompromised: compromised });
    beforeHeartbeat();
    fs.utimesSync(`${file}.lock`, new Date(0), new Date(0));
    heartbeat();
    assert.equal((await failed).code, "ECOMPROMISED");
    await assert.rejects(compromisedRelease(), { code: "ERELEASED" });
    assert.equal(fs.existsSync(`${file}.lock`), true, "a compromised lock is not ours to remove");
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
    globalThis.clearTimeout = nativeClearTimeout;
    fs.rmSync(`${file}.lock`, { recursive: true, force: true });
  }
}

if (mode === "import") {
  await import(crablineEntry);
  assert.deepEqual(snapshot(), before, "import must preserve process and native fs functions");
} else if (mode === "features") {
  const eventNames = ["exit", "SIGINT", "SIGTERM", "SIGHUP"];
  const listeners = () => eventNames.map((name) => process.listenerCount(name));
  const initial = listeners();
  const release = await locks.lock(file);
  assert.equal(locks.checkSync(file), true);
  await assert.rejects(locks.lock(file), { code: "ELOCKED" });
  assert.ok(listeners().every((count, index) => count > initial[index]));
  const owned = listeners();
  const second = path.join(directory, "second");
  fs.writeFileSync(second, "fixture");
  const releaseSecond = await locks.lock(second);
  assert.deepEqual(listeners(), owned, "one module must own one set of cleanup listeners");
  await release();
  assert.equal(locks.checkSync(file), false);
  assert.deepEqual(listeners(), owned, "another held lock must retain lifecycle ownership");
  await releaseSecond();
  assert.deepEqual(listeners(), initial, "last release must remove the owned listeners");
  const syncRelease = locks.lockSync(file);
  assert.equal(locks.checkSync(file), true);
  syncRelease();
  assert.deepEqual(listeners(), initial);

  fs.mkdirSync(`${file}.lock`);
  fs.utimesSync(`${file}.lock`, new Date(0), new Date(0));
  const staleRelease = await locks.lock(file, { stale: 2000 });
  await staleRelease();
  assert.equal(fs.existsSync(`${file}.lock`), false);

  await compromiseLock();
  assert.deepEqual(listeners(), initial, "compromise must relinquish lifecycle ownership");
  const { createServerRecorder } = await import(new URL("./servers/recorder.js", crablineEntry));
  const recorderPath = path.join(directory, "events.jsonl");
  const recorder = createServerRecorder({ recorderPath, onEvent: undefined });
  const events = ["first", "second"].map((value) => ({
    at: "2026-01-01T00:00:00.000Z",
    method: "POST",
    path: "/fixture",
    query: {},
    type: "api",
    body: { value },
  }));
  await Promise.all(events.map((event) => recorder.record(event)));
  await recorder.close();
  assert.deepEqual(
    fs
      .readFileSync(recorderPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
    events,
  );
  assert.deepEqual(
    snapshot(),
    before,
    "locking and recording must preserve process and native fs functions",
  );
} else if (mode === "handled") {
  let handled = false;
  process.once(signal, () => {
    handled = true;
  });
  const release = await locks.lock(file);
  process.emit(signal);
  assert.equal(handled, true);
  assert.equal(locks.checkSync(file), true, "an application handler may keep the process alive");
  await release();
} else if (mode === "exit") {
  const removed = process.listenerCount("removeListener");
  await locks.lock(file);
  if (observer.endsWith("veto")) {
    process.emit(signal);
    assert.equal(locks.checkSync(file), true);
  }
  process.on("exit", () => {
    assert.equal(process.listenerCount("removeListener"), removed);
  });
  process.exitCode = 23;
} else if (mode === "veto-release") {
  const removed = process.listenerCount("removeListener");
  const release = await locks.lock(file);
  process.emit(signal);
  assert.equal(locks.checkSync(file), true, "a vetoed exit must retain lock ownership");
  await release();
  for (const dispose of observerDisposers) {
    dispose();
  }
  assert.equal(process.listenerCount(signal), 0);
  assert.equal(process.listenerCount("removeListener"), removed);
} else if (mode === "veto-compromise") {
  const removed = process.listenerCount("removeListener");
  await compromiseLock(() => {
    process.emit(signal);
    assert.equal(locks.checkSync(file), true);
  });
  for (const dispose of observerDisposers) {
    dispose();
  }
  assert.equal(process.listenerCount(signal), 0);
  assert.equal(process.listenerCount("removeListener"), removed);
} else if (mode === "signal") {
  await locks.lock(file);
  if (observer.endsWith("veto")) {
    process.emit(signal);
    assert.equal(locks.checkSync(file), true, "a vetoed exit must not release a live owner's lock");
  }
  process.kill(process.pid, signal);
  // Keep the fixture alive if a passive observer accidentally swallows termination.
  setTimeout(() => process.exit(99), 5000);
} else if (mode === "copies") {
  const copy = path.join(directory, "copy");
  fs.cpSync(path.dirname(modulePath), copy, { recursive: true });
  fs.mkdirSync(path.join(copy, "node_modules"), { recursive: true });
  for (const dependency of ["retry"]) {
    const dependencyRoot = path.dirname(
      createRequire(modulePath).resolve(`${dependency}/package.json`),
    );
    fs.symlinkSync(dependencyRoot, path.join(copy, "node_modules", dependency), "junction");
  }
  const other = require(path.join(copy, "index.js"));
  const second = path.join(directory, "second");
  fs.writeFileSync(second, "fixture");
  await locks.lock(file);
  await other.lock(second);
  if (observer.endsWith("veto")) {
    process.emit(signal);
    assert.equal(locks.checkSync(file), true);
    assert.equal(other.checkSync(second), true);
  }
  process.kill(process.pid, signal);
  setTimeout(() => process.exit(99), 5000);
} else {
  throw new Error(`Unknown fixture mode: ${mode}`);
}

if (!["exit", "signal", "copies"].includes(mode)) {
  console.log(`${mode} passed`);
}
