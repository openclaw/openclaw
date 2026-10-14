import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const filename = fileURLToPath(import.meta.url);
const directory = path.dirname(filename);
// Clear the exact inherited option before imports that can create child runtimes.
// Node retains its native preload path for Workers; the owner retains this file.
if (process.env.NODE_OPTIONS === `--import=${filename}`) delete process.env.NODE_OPTIONS;
const mono = () => Number(process.hrtime.bigint() / 1000n);

function runningOwner(owner) {
  const fields = fs.readFileSync(`/proc/${owner.pid}/stat`, "utf8").split(") ").at(-1).split(" ");
  return !["Z", "X", "x"].includes(fields[0]) && fields[19] === owner.start;
}

function writePrivateJson(directory, name, value) {
  const pending = path.join(directory, `${name}.pending`);
  fs.writeFileSync(pending, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  fs.renameSync(pending, path.join(directory, name));
}

async function runPreload() {
  let releaseEntry;
  const ready = new Promise((resolve) => {
    releaseEntry = resolve;
  });
  const processStart = (pid) =>
    fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1).split(" ")[19];
  const metadata = (file) => {
    const s = fs.statSync(file);
    return { dev: s.dev, ino: s.ino, size: s.size, uid: s.uid, gid: s.gid, mode: s.mode };
  };
  function readRootJson(name) {
    const fd = fs.openSync(
      path.join(directory, name),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    try {
      const s = fs.fstatSync(fd);
      assert(s.isFile() && s.uid === 0 && s.nlink === 1 && !(s.mode & 0o022) && s.size <= 4096);
      return JSON.parse(fs.readFileSync(fd, "utf8"));
    } finally {
      fs.closeSync(fd);
    }
  }
  const claimCapture = (value) => {
    const fd = fs.openSync(path.join(directory, "spool", "capture-claim.json"), "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); } finally { fs.closeSync(fd); }
  };
  let watcher,
    expiry,
    intent,
    terminal = false;
  const record = (value) => {
    try {
      fs.appendFileSync(
        path.join(directory, "spool", "admission-events.jsonl"),
        JSON.stringify({ atMonotonicMicros: mono(), pid: process.pid, ...value }) + "\n",
        { mode: 0o600 },
      );
    } catch {
      /* An unavailable diagnostic spool must not crash the managed process. */
    }
  };
  function stopWaiting(event, detail) {
    if (terminal) return false;
    terminal = true;
    watcher?.close();
    clearTimeout(expiry);
    record({ event, ...detail });
    return true;
  }
  function releaseWithoutCapture(event, detail) {
    if (stopWaiting(event, detail)) releaseEntry();
  }
  function aliveOwner() {
    return (
      runningOwner(intent.owner) &&
      fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() === intent.bootId &&
      mono() < intent.expiresMicros
    );
  }
  function armSteady(binding) {
    const cancellation = new AbortController();
    let observer, timer, scope;
    const close = (reason) => {
      observer?.close();
      clearTimeout(timer);
      if (!cancellation.signal.aborted) {
        record({ event: "registration.closed", reason });
        cancellation.abort(reason);
      }
    };
    const check = (request, admitting) => {
      assert(!cancellation.signal.aborted);
      assert(!fs.existsSync(path.join(directory, "steady-revoked.json")));
      assert.deepEqual(readRootJson("steady-request.json"), request);
      assert.deepEqual(Object.keys(request).sort(), [
        "operation", "nonce", "owner", "bootId", "binding", "issuedMicros", "admitBeforeMicros", "deadlineMicros",
      ].sort());
      assert.deepEqual(Object.keys(request.owner).sort(), ["pid", "start"]);
      assert(Number.isSafeInteger(request.owner.pid) && request.owner.pid > 0);
      assert(/^[1-9][0-9]*$/.test(request.owner.start));
      assert(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(request.nonce));
      assert.equal(request.operation, intent.operation);
      assert.deepEqual(request.binding, binding);
      assert.equal(processStart(process.pid), binding.start);
      assert.equal(request.bootId, intent.bootId);
      assert.equal(fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), intent.bootId);
      assert(runningOwner(request.owner));
      for (const key of ["issuedMicros", "admitBeforeMicros", "deadlineMicros"]) assert(Number.isSafeInteger(request[key]));
      assert.equal(request.admitBeforeMicros - request.issuedMicros, 5_000_000);
      assert.equal(request.deadlineMicros - request.issuedMicros, 60_000_000);
      assert(request.deadlineMicros <= intent.armedUntilMicros);
      const now = mono();
      assert(request.issuedMicros <= now && now < request.deadlineMicros);
      if (admitting) assert(now < request.admitBeforeMicros);
    };
    const inspect = async () => {
      if (cancellation.signal.aborted) return;
      try {
        assert(mono() < intent.armedUntilMicros);
        assert(!fs.existsSync(path.join(directory, "steady-revoked.json")));
        if (scope) { scope.check(false); return; }
        let request;
        try { request = readRootJson("steady-request.json"); }
        catch (error) { if (error.code === "ENOENT") return; throw error; }
        check(request, true);
        // In-memory claim precedes every await; an exclusive artifact records that single use.
        scope = { request, signal: cancellation.signal, check: (admitting) => check(request, admitting) };
        claimCapture({ ...binding, nonce: request.nonce });
        clearTimeout(timer);
        const capture = await startCapture({ directory: path.join(directory, "spool"), scope });
        capture.completion.then(() => close("complete"), () => close("capture-failed"));
      } catch {
        close("refused-or-revoked");
      }
    };
    try {
      observer = fs.watch(directory, { persistent: false }, (_event, name) => {
        if (name === null || name === "steady-request.json" || name === "steady-revoked.json") void inspect();
      });
      observer.once("error", () => close("watch-error"));
      timer = setTimeout(() => close("expired"), Math.max(0, (intent.armedUntilMicros - mono()) / 1000)).unref();
      writePrivateJson(path.join(directory, "spool"), "registration-ready.json", {
        ...binding, armedUntilMicros: intent.armedUntilMicros,
      });
      void inspect();
    } catch {
      close("registration-failed");
    }
  }
  async function tryAdmission() {
    if (terminal) return;
    let admission;
    try {
      admission = readRootJson("admission.json");
    } catch (error) {
      if (error.code === "ENOENT") return;
      releaseWithoutCapture("admission.rejected", { reason: "invalid-root-artifact" });
      return;
    }
    try {
      assert.deepEqual(
        Object.keys(admission).sort(),
        ["invocationId", "operation", "pid", "start"].sort(),
      );
      assert.equal(admission.operation, intent.operation);
      assert.equal(admission.pid, process.pid);
      assert.equal(admission.start, processStart(process.pid));
      assert.equal(admission.invocationId, process.env.INVOCATION_ID);
      assert(aliveOwner());
      assert.deepEqual(metadata(process.execPath), intent.node);
      assert.deepEqual(metadata(intent.entry), intent.entryMetadata);
      assert.equal(fs.realpathSync(process.argv[1]), intent.entry);
      assert.equal(fs.realpathSync(process.cwd()), intent.release);
      if (intent.mode === "steady") {
        stopWaiting("admission.accepted", { admission });
        armSteady(admission);
        releaseEntry();
        return;
      }
      claimCapture(admission);
      stopWaiting("admission.accepted", { admission });
      // The owner already validated the sealed source. No discovery or hashing runs here.
      const { completion } = await startCapture({ directory: path.join(directory, "spool") });
      completion.catch((error) => {
        record({ event: "capture.rejected", code: error.code ?? "capture-refused" });
      });
      releaseEntry();
    } catch (error) {
      if (terminal) record({ event: "capture.rejected", code: error.code ?? "capture-refused" });
      else
        stopWaiting("admission.rejected", {
          reason: "binding-or-expiry",
          code: error.code ?? "capture-refused",
        });
      releaseEntry();
    }
  }
  try {
    const stat = fs.lstatSync(directory);
    assert(
      stat.isDirectory() &&
        stat.uid === 0 &&
        !(stat.mode & 0o022) &&
        fs.realpathSync(directory) === directory,
    );
    intent = readRootJson("intent.json");
    assert.deepEqual(
      Object.keys(intent).sort(),
      [
        "bootId",
        "cgroup",
        "entry",
        "entryMetadata",
        "expiresMicros",
        "gid",
        "node",
        "nodeVersion",
        "operation",
        "owner",
        "release",
        "uid",
        ...(intent.mode === "steady" ? ["mode", "armedUntilMicros"] : []),
      ].sort(),
    );
    assert.equal(process.version, intent.nodeVersion);
    assert.equal(process.ppid, 1);
    assert.equal(process.getuid(), intent.uid);
    assert.equal(process.getgid(), intent.gid);
    assert.equal(process.env.NODE_OPTIONS, undefined);
    assert.deepEqual(process.argv.slice(2), ["gateway", "--port", "18789"]);
    assert.equal(fs.realpathSync(process.argv[1]), intent.entry);
    assert.equal(fs.realpathSync(process.cwd()), intent.release);
    assert.equal(fs.readFileSync("/proc/self/cgroup", "utf8"), `0::${intent.cgroup}\n`);
    assert(
      Number.isSafeInteger(intent.expiresMicros) && intent.expiresMicros - mono() <= 120000000,
    );
    assert(aliveOwner());
    if (intent.mode === "steady") {
      assert(Number.isSafeInteger(intent.armedUntilMicros));
      assert.equal(intent.armedUntilMicros - intent.expiresMicros, 780_000_000);
    }
    const fd = fs.openSync(path.join(directory, "spool", "bootstrap-claim.json"), "wx", 0o600);
    try {
      fs.writeFileSync(
        fd,
        JSON.stringify({
          pid: process.pid,
          start: processStart(process.pid),
          invocationId: process.env.INVOCATION_ID,
        }),
      );
    } finally {
      fs.closeSync(fd);
    }
    watcher = fs.watch(directory, { persistent: false }, (_event, name) => {
      if (name === "admission.json" || name === null) void tryAdmission();
    });
    watcher.once("error", () =>
      releaseWithoutCapture("admission.rejected", { reason: "watch-error" }),
    );
    const remainingMs = Math.max(0, (intent.expiresMicros - mono()) / 1000);
    // Startup capture waits for admission; steady admission must not hold Gateway entry.
    // This timer bounds waiting only; native Inspector startup is not timer-preemptible.
    expiry = setTimeout(
      () =>
        releaseWithoutCapture(remainingMs <= 5000 ? "admission.expired" : "admission.timeout", {}),
      Math.min(5000, remainingMs),
    );
    record({ event: "admission.watching" });
    if (intent.mode === "steady") {
      expiry.unref();
      releaseEntry();
    }
    // Register first, then read: either publication order reaches the same exact gate.
    void tryAdmission();
  } catch (error) {
    watcher?.close();
    clearTimeout(expiry);
    record({ event: "bootstrap.rejected", code: error.code ?? "capture-refused" });
    releaseEntry();
  }
  await ready;
}

export function profileFacts(text) {
  const p = JSON.parse(text),
    ids = new Set(p.nodes.map((n) => n.id));
  assert.equal(ids.size, p.nodes.length);
  assert(p.samples.length > 0 && p.samples.length === p.timeDeltas.length);
  assert(p.samples.every((id) => ids.has(id)));
  assert(p.endTime > p.startTime);
  let timestamp = p.startTime;
  for (const delta of p.timeDeltas) {
    assert(Number.isSafeInteger(delta));
    timestamp += delta;
    assert(timestamp >= p.startTime && timestamp <= p.endTime);
  }
  return {
    bytes: Buffer.byteLength(text),
    sha256: crypto.createHash("sha256").update(text).digest("hex"),
    samples: p.samples.length,
    nodes: p.nodes.length,
    startTime: p.startTime,
    endTime: p.endTime,
    profileDurationMs: (p.endTime - p.startTime) / 1000,
    negativeDeltaCount: p.timeDeltas.filter((n) => n < 0).length,
  };
}
async function startCapture({ directory, durationMs = 30000, sampleInterval = 5, scope }) {
  const inspector = await import("node:inspector");
  scope?.check(true);
  assert.equal(inspector.url(), undefined);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const fd = fs.openSync(path.join(directory, "capture-events.jsonl"), "wx", 0o600);
  const record = (event) =>
    fs.writeSync(
      fd,
      JSON.stringify({ atMonotonicMicros: mono(), pid: process.pid, ...event }) + "\n",
    );
  // Publish terminal records only after their complete bytes are closed.
  const write = (name, value) => writePrivateJson(directory, name, value);
  const errorRecord = (error) => {
    const detail = {
      message: String(error).slice(0, 2000),
      stack: String(error.stack ?? "").slice(0, 4000),
    };
    try {
      write("capture-error.json", detail);
      record({ event: "capture.error", ...detail });
    } catch (retentionError) {
      console.error("Capture error retention failed:", String(retentionError).slice(0, 2000));
    }
  };
  const session = new inspector.Session();
  let connected = false;
  const post = (method, params = {}) =>
    new Promise((resolve, reject) =>
      session.post(method, params, (error, value) => (error ? reject(error) : resolve(value))),
    );
  const cleanup = async () => {
    const started = mono();
    try {
      if (connected) await post("Profiler.disable");
    } finally {
      try {
        if (connected) session.disconnect();
        connected = false;
        record({
          event: "capture.cleanup",
          cleanupMs: (mono() - started) / 1000,
          listenerUrl: inspector.url() ?? null,
        });
      } finally {
        fs.closeSync(fd);
      }
    }
  };
  const startRequestedMicros = mono();
  let recordingStartedMicros;
  try {
    session.connect();
    connected = true;
    for (const [method, params] of [
      ["Profiler.enable", {}],
      ["Profiler.setSamplingInterval", { interval: sampleInterval * 1000 }],
      ["Profiler.start", {}],
    ]) {
      scope?.check(true);
      await post(method, params);
      scope?.check(true);
    }
    recordingStartedMicros = mono();
    assert.equal(inspector.url(), undefined);
    record({
      event: "capture.start",
      enabled: true,
      api: "inspector-session",
      startRequestedMicros,
      recordingStartedMicros,
      profileStartMs: (recordingStartedMicros - startRequestedMicros) / 1000,
      durationMs,
      sampleInterval,
      listenerUrl: null,
      execPath: process.execPath,
      version: process.version,
    });
    if (scope) write("capture-started.json", { request: scope.request, recordingStartedMicros, pid: process.pid });
  } catch (error) {
    try {
      errorRecord(error);
    } finally {
      await cleanup();
    }
    throw error;
  }
  async function finish(stopReason) {
    const stopRequestedMicros = mono();
    let result;
    try {
      record({ event: "capture.stop-requested", stopRequestedMicros, recordingStartedMicros });
      const response = await post("Profiler.stop");
      const stoppedMicros = mono();
      record({
        event: "capture.stopped",
        stopRequestedMicros,
        stoppedMicros,
        stopMs: (stoppedMicros - stopRequestedMicros) / 1000,
      });
      const stringifyStartedMicros = mono();
      const text = JSON.stringify(response.profile);
      const stringifyFinishedMicros = mono();
      record({
        event: "capture.stringify",
        stringifyMs: (stringifyFinishedMicros - stringifyStartedMicros) / 1000,
        bytes: Buffer.byteLength(text),
      });
      await fs.promises.writeFile(path.join(directory, "capture.cpuprofile"), text, {
        flag: "wx",
        mode: 0o600,
      });
      result = {
        enabled: true,
        api: "inspector-session",
        pid: process.pid,
        version: process.version,
        startRequestedMicros,
        recordingStartedMicros,
        stopRequestedMicros,
        stoppedMicros,
        durationMs,
        sampleInterval,
        profileStartMs: (recordingStartedMicros - startRequestedMicros) / 1000,
        actualStopAtMs: (stopRequestedMicros - recordingStartedMicros) / 1000,
        stopMs: (stoppedMicros - stopRequestedMicros) / 1000,
        stringifyMs: (stringifyFinishedMicros - stringifyStartedMicros) / 1000,
        listenerUrl: inspector.url() ?? null,
        profile: profileFacts(text),
      };
      assert.equal(inspector.url(), undefined);
      record({ event: "capture.complete", profile: result.profile });
    } catch (error) {
      errorRecord(error);
      throw error;
    } finally {
      await cleanup();
    }
    if (scope) {
      let authorityAtCompletion = true;
      try { scope.check(false); } catch { authorityAtCompletion = false; }
      Object.assign(result, { mode: "steady", request: scope.request, stopReason,
        completedMicros: mono(), authorityAtCompletion });
    }
    write("capture-result.json", result);
    return result;
  }
  let timer, stopping = false;
  let resolveCompletion, rejectCompletion;
  const completion = new Promise((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
  // Expired/revoked authority cannot forbid cleanup of this already-owned Session.
  const stopOnce = (reason) => {
    if (stopping) return;
    stopping = true;
    clearTimeout(timer);
    scope?.signal.removeEventListener("abort", abort);
    finish(reason).then(resolveCompletion, rejectCompletion);
  };
  const abort = () => stopOnce("cancelled");
  const tick = () => {
    if (scope) {
      try { scope.check(false); } catch { stopOnce("authority-lost"); return; }
    }
    const remaining = (recordingStartedMicros + durationMs * 1000 - mono()) / 1000;
    if (remaining <= 0) { stopOnce("duration"); return; }
    timer = setTimeout(tick, scope ? Math.min(1000, remaining) : remaining).unref();
  };
  scope?.signal.addEventListener("abort", abort, { once: true });
  tick();
  // Only confirmed Profiler.start gates entry; completion never holds it open.
  return { completion };
}

// Root collectors import profileFacts; only the unprivileged managed service bootstraps.
if (process.env.SYSTEMD_EXEC_PID === String(process.pid) && process.getuid?.() !== 0) {
  const { isMainThread } = await import("node:worker_threads");
  if (isMainThread) await runPreload();
}
