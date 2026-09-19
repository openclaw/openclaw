#!/usr/bin/env node
// Real Node launcher boundary proof, not managed-Gateway or native Windows/launchd acceptance.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const mode = process.argv.find((arg) => arg.startsWith("--mode="))?.slice(7) ?? "recovery";
assert(["recovery", "packaged", "generic", "failure", "stuck"].includes(mode));
if (process.platform === "win32") {
  throw new Error("This POSIX signal proof does not establish native Windows behavior.");
}
// openclaw-temp-dir: allow standalone proof has no Vitest lifecycle; finally joins children then removes it.
const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-launcher-drain-proof-"));
let supervisor;
let ownerPid;
let joined;
let output = "";
let stderr = "";
function alive(pid) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function readState(name, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      return JSON.parse(await readFile(path.join(root, name), "utf8"));
    } catch {}
    if (supervisor && supervisor.exitCode !== null) {
      throw new Error(`supervisor exited: ${stderr}`);
    }
    await delay(10);
  }
  throw new Error(`Missing ${name}: ${stderr}`);
}
try {
  const worker = path.join(root, "worker.mjs");
  await writeFile(
    worker,
    `
import { createServer } from "node:http";
import { writeFileSync, openSync, fsyncSync, closeSync } from "node:fs";
import { getCompileCacheDir } from "node:module";
const root = ${JSON.stringify(root)};
const mode = ${JSON.stringify(mode)};
let draining = false;
let pending;
const save = (name, value) => writeFileSync(root + "/" + name, JSON.stringify(value));
const server = createServer((req, res) => {
  if (draining) { res.writeHead(503); res.end("denied"); return; }
  if (req.url !== "/work") { res.writeHead(404); res.end(); return; }
  pending = res;
  res.writeHead(200, { "Content-Type": "text/plain", "Connection": "close" });
  res.write("accepted\\n");
  save("admitted.json", { pid: process.pid });
});
process.on("SIGTERM", () => {
  if (draining) { save("repeated.json", { at: Date.now() }); return; }
  draining = true;
  save("draining.json", { at: Date.now(), pid: process.pid });
  if (mode === "stuck") return;
  setTimeout(() => {
    if (mode === "failure") {
      save("failed.json", { status: "provider-failure" });
      process.stderr.write("provider-failure\\n");
      pending?.destroy(); server.close(); process.exit(17);
    }
    const effect = { status: "completed", pid: process.pid, ownedWork: 0 };
    const fd = openSync(root + "/effect.json", "w");
    writeFileSync(fd, JSON.stringify(effect)); fsyncSync(fd); closeSync(fd);
    pending.end("final-output\\n");
    process.stdout.write("final-output\\n");
    server.close(() => process.exit(0));
  }, 3025);
});
server.listen(0, "127.0.0.1", () => save("ready.json", {
  pid: process.pid, ppid: process.ppid, port: server.address().port,
  compileCache: Boolean(getCompileCacheDir()),
  packagedRespawned: process.env.OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED === "1"
}));
`,
  );
  let argv;
  const env = { PATH: process.env.PATH, HOME: root, TMPDIR: root, CI: "1" };
  if (mode === "packaged") {
    for (const file of [
      "openclaw.mjs",
      "node-host-launcher.mjs",
      "node-runtime-recovery.mjs",
      "node-runtime-update.mjs",
      "node-version.mjs",
      "node-sqlite.mjs",
    ]) {
      await copyFile(path.join(repoRoot, file), path.join(root, file));
    }
    await mkdir(path.join(root, "dist"));
    await copyFile(worker, path.join(root, "dist/entry.js"));
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ type: "module", version: "0.0.0-proof" }),
    );
    env.NODE_COMPILE_CACHE = path.join(root, ".node-cache");
    argv = [path.join(root, "openclaw.mjs"), "--profile=fixture", "gateway", "run"];
  } else {
    const bridge = path.join(root, "supervisor.mjs");
    await writeFile(
      bridge,
      `import { runRespawnedChild } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "node-runtime-recovery.mjs")).href)}; runRespawnedChild(process.execPath, [${JSON.stringify(worker)}], process.env);`,
    );
    argv = [bridge, "gateway", mode === "generic" ? "status" : "run"];
  }
  supervisor = spawn(process.execPath, argv, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  supervisor.stdout.setEncoding("utf8").on("data", (data) => {
    output += data;
  });
  supervisor.stderr.setEncoding("utf8").on("data", (data) => {
    stderr += data;
  });
  joined = once(supervisor, "exit");
  const ready = await readState("ready.json");
  ownerPid = ready.pid;
  assert.notEqual(ownerPid, supervisor.pid);
  assert.equal(ready.ppid, supervisor.pid);
  if (mode === "packaged") {
    assert.equal(ready.compileCache, true);
    assert.equal(ready.packagedRespawned, true);
  }
  const response = await fetch(`http://127.0.0.1:${ready.port}/work`);
  const body = response.text().then(
    (text) => ({ text }),
    () => ({ error: true }),
  );
  await readState("admitted.json");
  const started = performance.now();
  supervisor.kill("SIGTERM");
  await readState("draining.json");
  const denied = await fetch(`http://127.0.0.1:${ready.port}/denied`);
  assert.equal(denied.status, 503);
  assert.equal(await denied.text(), "denied");
  if (mode === "stuck") {
    await delay(1500);
    supervisor.kill("SIGTERM");
    await readState("repeated.json");
  }
  let timeout;
  const result = await Promise.race([
    joined.then(([code, signal]) => ({ code, signal })),
    new Promise((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`shutdown timed out: ${stderr}`)),
        mode === "stuck" ? 340000 : 12000,
      );
    }),
  ]).finally(() => clearTimeout(timeout));
  const elapsedMs = performance.now() - started;
  const received = await body;
  if (mode === "generic" || mode === "stuck") {
    assert.equal(result.signal, "SIGKILL");
    assert(elapsedMs >= (mode === "stuck" ? 328000 : 1900));
    assert(elapsedMs < (mode === "stuck" ? 331000 : 5000));
    await assert.rejects(readFile(path.join(root, "effect.json")), { code: "ENOENT" });
    assert(!output.includes("final-output"));
  } else if (mode === "failure") {
    assert.deepEqual(result, { code: 17, signal: null });
    assert(stderr.includes("provider-failure"));
    await assert.rejects(readFile(path.join(root, "effect.json")), { code: "ENOENT" });
    assert(!output.includes("final-output"));
  } else {
    assert.deepEqual(result, { code: 0, signal: null });
    assert.equal(received.text, "accepted\nfinal-output\n");
    assert(output.includes("final-output\n"));
    assert.deepEqual(await readState("effect.json"), {
      status: "completed",
      pid: ownerPid,
      ownedWork: 0,
    });
    assert(elapsedMs >= 3000);
  }
  assert.equal(alive(ownerPid), false);
  assert.equal(alive(supervisor.pid), false);
  console.log(
    JSON.stringify({
      mode,
      supervisorPid: supervisor.pid,
      ownerPid,
      elapsedMs,
      ...result,
      deniedAdmission: 503,
      finalEffect: mode === "recovery" || mode === "packaged",
      compileCache: ready.compileCache,
      packagedRespawned: ready.packagedRespawned,
      source: path.join(repoRoot, "node-runtime-recovery.mjs"),
      platform: process.platform,
    }),
  );
} finally {
  for (const pid of [ownerPid, supervisor?.pid]) {
    if (alive(pid)) {
      process.kill(pid, "SIGKILL");
    }
  }
  if (joined) {
    await joined;
  }
  await rm(root, { recursive: true, force: true });
}
