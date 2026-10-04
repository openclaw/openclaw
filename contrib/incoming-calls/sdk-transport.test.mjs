import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("./incoming-call.mjs", import.meta.url));
const gateway = "wss://gateway.example:18789";

function installation(t, name = "selected") {
  // openclaw-temp-dir: allow Node's standalone test runner owns and removes this synthetic installation.
  const root = mkdtempSync(join(tmpdir(), `incoming-call-${name}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = join(root, "node_modules", "openclaw");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "openclaw",
      type: "module",
      bin: { openclaw: "openclaw.mjs" },
      exports: { "./plugin-sdk/gateway-runtime": "./gateway-runtime.mjs" },
    }),
  );
  const binary = join(pkg, "openclaw.mjs");
  writeFileSync(
    binary,
    "#!/usr/bin/env node\nprocess.stderr.write('Generic CLI has no signed device identity'); process.exit(1);\n",
    { mode: 0o755 },
  );
  const state = join(pkg, "state.json");
  writeFileSync(state, JSON.stringify({ calls: [], messages: [], status: "unknown" }));
  writeFileSync(
    join(pkg, "gateway-runtime.mjs"),
    `
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
const stateFile = new URL('./state.json', import.meta.url);
export async function callGatewayFromCli(method, opts, params, extra) {
  assert.equal(opts.expectUrl, '${gateway}', 'synthetic-sensitive-endpoint');
  assert.equal(opts.url, undefined);
  assert.equal(opts.token, undefined);
  assert.equal(opts.password, undefined);
  assert.equal(opts.json, true);
  assert.equal(extra.useStoredDeviceAuth, true);
  assert.equal(extra.sharedStateMode, 'read-only');
  assert.equal(extra.scopes, undefined);
  assert.equal(extra.deviceIdentity, undefined);
  const scope = method === 'chat.inject' ? 'operator.admin' : ['node.list', 'chat.history'].includes(method) ? 'operator.read' : 'operator.write';
  assert.deepEqual(extra.requiredStoredDeviceAuthScopes, [scope]);
  const state = JSON.parse(readFileSync(stateFile));
  if (state.rejectAuth) throw new Error('synthetic-sensitive-auth-error');
  state.calls.push({ method, params });
  let result;
  if (method === 'node.list') result = { nodes: [{ nodeId: 'synthetic-android', platform: 'android', paired: true, connected: !state.offline, commands: ['talk.incoming', 'talk.callStatus', 'talk.endCall'] }] };
  else if (method === 'sessions.create') { state.key = params.key; result = { ok: true, key: params.key, runStarted: false }; }
  else if (method === 'chat.history') result = { messages: state.messages.map(content => ({ role: 'assistant', content })) };
  else if (method === 'chat.inject') { state.messages.push(params.message); result = { ok: true, messageId: 'synthetic-' + state.messages.length }; }
  else {
    assert.equal(method, 'node.invoke');
    if (params.command === 'talk.incoming') state.status = 'ringing';
    else if (params.command === 'talk.endCall') state.status = 'ended';
    else assert.equal(params.command, 'talk.callStatus');
    result = { ok: true, nodeId: params.nodeId, command: params.command, payload: { callId: params.params.callId, sessionKey: state.key, status: state.status } };
  }
  writeFileSync(stateFile, JSON.stringify(state));
  return result;
}
`,
  );
  const bin = join(root, "bin");
  mkdirSync(bin);
  if (process.platform === "win32") {
    // npm's command shim resolves packages from its own installation, not this checkout.
    writeFileSync(join(root, "openclaw.cmd"), "@echo off\r\n");
  } else {
    symlinkSync(binary, join(bin, "openclaw"));
  }
  const briefing = join(root, "briefing.txt");
  writeFileSync(
    briefing,
    "Synthetic facts. $(not-a-shell) `not-a-command`\nDecision: compare options.",
  );
  return {
    root,
    binary,
    state,
    briefing,
    command: process.platform === "win32" ? join(root, "openclaw.cmd") : join(bin, "openclaw"),
    receipt: join(root, "receipt.json"),
    read: () => JSON.parse(readFileSync(state, "utf8")),
  };
}

function run(f, operation, args = [], env = {}) {
  return spawnSync(process.execPath, [cli, operation, "--receipt", f.receipt, ...args], {
    encoding: "utf8",
    timeout: 10000,
    shell: false,
    env: { ...process.env, ...env },
  });
}

function prepareArgs(f) {
  return [
    "--agent",
    "test-agent",
    "--topic",
    "Synthetic comparison",
    "--briefing",
    f.briefing,
    "--expect-url",
    gateway,
  ];
}

test("actual CLI uses the selected installation's signed-device SDK for the complete call workflow", (t) => {
  const f = installation(t);
  const other = installation(t, "other");
  const env = {
    PATH: dirname(other.command) + (process.platform === "win32" ? ";" : ":") + process.env.PATH,
  };
  for (const [operation, expected] of [
    ["prepare", undefined],
    ["ring", "ringing"],
    ["status", "ringing"],
    ["end", "ended"],
  ]) {
    const result = run(
      f,
      operation,
      ["--binary", f.command, ...(operation === "prepare" ? prepareArgs(f) : [])],
      env,
    );
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    if (expected) {
      assert.equal(output.status, expected);
    } else {
      assert.equal(output.prepared, true);
    }
  }
  const state = f.read();
  assert.equal(state.calls.filter((call) => call.method === "sessions.create").length, 1);
  assert.equal(state.calls.filter((call) => call.params.command === "talk.incoming").length, 1);
  assert.equal(
    state.calls.some((call) => ["chat.send", "agent"].includes(call.method)),
    false,
  );
  assert.deepEqual(other.read().calls, []);
});

test("default executable lookup honors PATH and never falls back to another SDK after a selected install fails", (t) => {
  const f = installation(t);
  const env = { PATH: dirname(f.command), PATHEXT: ".CMD;.EXE" };
  const result = run(f, "prepare", prepareArgs(f), env);
  assert.equal(result.status, 0, result.stderr);
  const bad = join(f.root, "unknown-install", "openclaw");
  mkdirSync(dirname(bad));
  writeFileSync(bad, "#!/usr/bin/env node\n", { mode: 0o755 });
  const failed = run(f, "status", ["--binary", bad], env);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /installed OpenClaw/);
});

test("pin mismatch, rejected device auth and an offline node cannot create a session or ring", (t) => {
  for (const mode of ["pin", "auth", "offline"]) {
    const f = installation(t, mode);
    if (mode !== "pin") {
      writeFileSync(
        f.state,
        JSON.stringify({ ...f.read(), [mode === "auth" ? "rejectAuth" : "offline"]: true }),
      );
    }
    const args = prepareArgs(f);
    if (mode === "pin") {
      args[args.length - 1] = "wss://different.example:18789";
    }
    const result = run(f, "prepare", ["--binary", f.command, ...args]);
    assert.equal(result.status, 1);
    assert.equal(result.stderr.includes("synthetic-sensitive"), false);
    assert.equal(
      f
        .read()
        .calls.some((call) => call.method === "sessions.create" || call.method === "node.invoke"),
      false,
    );
  }
});
