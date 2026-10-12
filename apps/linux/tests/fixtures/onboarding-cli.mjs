// The native app owns runtime admission and launcher publication. This fixture
// implements only the CLI/service boundary; no host service is installed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const installed = "fixture-runtime-installed.json";
const expectedPin = { revision: "fixture-absent", definition: null };
const prefix = path.join(homedir(), ".openclaw");
const port = 18789;
const reply = (value) => console.log(JSON.stringify(value));

if (args[0] === "gateway" && args[1] === "install") {
  assert.equal(existsSync(installed), false, "fresh setup must install exactly once");
  assert.deepEqual(args, [
    "gateway", "install", "--force", "--json", "--runtime", "bun", "--runtime-path",
    process.execPath, "--expected-runtime-pin", JSON.stringify(expectedPin), "--port", String(port),
  ]);
  assert.ok(process.execPath.startsWith(path.join(prefix, "tools/desktop-runtime/")));
  const manifest = JSON.parse(readFileSync(path.join(path.dirname(process.execPath), "../manifest.json")));
  assert.equal(spawnSync(process.execPath, ["--revision"], { encoding: "utf8" }).stdout.trim(), manifest.revision);
  appendFileSync("fixture-runtime-install-attempts", "install\n");
  const failure = path.join(homedir(), "fixture-install-failure");
  if (existsSync(failure)) {
    console.error(readFileSync(failure, "utf8"));
    process.exit(1);
  }
  writeFileSync(installed, JSON.stringify({ bun: process.execPath }));
  reply({ ok: true });
} else if (args[0] === "gateway" && args[1] === "status" && args.includes("--deep")) {
  assert.deepEqual(args.slice(0, 4), ["gateway", "status", "--deep", "--json"]);
  assert.ok(args.length === 4 || (args.length === 5 && args[4] === "--no-probe"));
  const active = existsSync(installed);
  const bun = active ? JSON.parse(readFileSync(installed)).bun : null;
  reply({
    service: {
      loaded: active, targetRole: "target", definitionMutation: "writable",
      launcherOverridden: false, revision: active ? "fixture-bundled" : "fixture-absent",
      command: active ? { programArguments: [bun, process.argv[1], "gateway"] } : null,
      runtime: active ? { status: "running", pid: 4100 } : null,
      runtimeIntent: active
        ? { status: "known", revision: "fixture-bundled", definition: "fixture-service", pin: { runtime: "bun", path: bun } }
        : { status: "known", ...expectedPin },
    },
    config: { daemon: { path: path.join(prefix, "openclaw.json") } },
    gateway: { port }, rpc: { ok: active },
    port: { port, status: active ? "busy" : "free", listeners: active ? [{ pid: 4100 }] : [] },
  });
} else {
  const child = spawnSync("/usr/bin/python3", [path.join(homedir(), "fixture-cli.py"), ...args], { stdio: "inherit" });
  assert.ifError(child.error);
  process.exit(child.status ?? 1);
}
