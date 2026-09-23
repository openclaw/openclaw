import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runTelegramTestScenario } from "./run-mock-sut-user-e2e.mjs";

function deadline(promise, label, milliseconds = 1500) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function composition(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-run-composition-"));
  const children = [];
  const watchers = [];
  const events = [];
  const controller = new AbortController();
  const originalFetch = globalThis.fetch;
  const originalSpawn = childProcess.spawn;
  const originalKill = process.kill;
  let released = 0;
  let healthy = true;
  const loss = Promise.withResolvers();
  const headerBody = Promise.withResolvers();
  const bodyStarted = Promise.withResolvers();
  let bodyController;
  let observedRequest;
  const waiters = new Map();
  const observe = (name, value) => {
    events.push(name);
    waiters.get(name)?.resolve(value);
  };
  const wait = (name) => {
    if (events.includes(name)) return Promise.resolve();
    const waiter = Promise.withResolvers();
    waiters.set(name, waiter);
    return waiter.promise;
  };
  fs.mkdirSync(path.join(root, "scripts/e2e"), { recursive: true });
  fs.mkdirSync(path.join(root, "dist"));
  fs.writeFileSync(
    path.join(root, "scripts/e2e/mock-openai-server.mjs"),
    `
    process.stdout.write(${JSON.stringify(mode === "mock" ? "fixture blocked\\n" : "mock-openai listening\\n")});
    setInterval(()=>{},1000);
  `.replaceAll("\\\\n", "\\n"),
  );
  fs.writeFileSync(
    path.join(root, "dist/entry.js"),
    `
    const http=require('node:http');
    const port=Number(process.argv[process.argv.indexOf('--port')+1]);
    http.createServer((req,res)=>{res.end('{}')}).listen(port,'127.0.0.1');
    if(${JSON.stringify(mode)}==='late') process.once('SIGTERM',()=>{
      const fs=require('node:fs'); const root=${JSON.stringify(root)};
      const exitWhenReleased=()=>{if(fs.existsSync(root+'/release-stop')) process.exit(0)};
      fs.watch(root,exitWhenReleased);
      fs.writeFileSync(root+'/stop-requested','');
      exitWhenReleased();
    });
  `,
  );
  if (mode === "uncertain-send") {
    fs.writeFileSync(
      path.join(root, "record-fixture.py"),
      `
import importlib.util
import sys
import time
from pathlib import Path

spec = importlib.util.spec_from_file_location("tg_record", sys.argv.pop(1))
record = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = record
spec.loader.exec_module(record)

class Client:
    observed = False
    def next_update(self, timeout):
        time.sleep(timeout)
        if self.observed:
            return None
        self.observed = True
        return {"@type": "updateNewMessage", "message": {
            "id": 42, "chat_id": 42, "date": int(time.time()), "sender_id": {"user_id": 42},
            "content": {"@type": "messageText", "text": {"text": "Late incoming observation"}},
        }}

class Driver:
    client = Client()
    def resolve_chat(self, selector):
        return 42
    def send_text(self, *args, **kwargs):
        with Path("send-attempts").open("a") as attempts:
            attempts.write("send")
        raise record.driver.DriverError("Timed out waiting for Telegram message send confirmation")

record.build_driver = lambda: ({"sutId": "42", "sutUsername": "sut_bot"}, {}, Driver())
sys.exit(record.main())
`,
    );
  }
  fs.writeFileSync(
    path.join(root, "uv"),
    `#!${process.execPath}
    const fs=require('node:fs');
    if(process.argv.includes('status')) { console.log(JSON.stringify({ok:true,authorized:true,testDc:true,tdlibVersion:'1.8.67',user:{id:123},chatId:-1001})); }
    else if(process.argv.includes('prepare-group')) { console.log(JSON.stringify({ok:true,groupId:'-1001',status:'created'})); }
    else if(process.argv.includes('cleanup-group')) { console.log(JSON.stringify({ok:true,groupId:'-1001',status:'deleted'})); }
    else if(${JSON.stringify(mode)}==='uncertain-send') {
      const index=process.argv.findIndex(value=>value.endsWith('user-record.py'));
      const result=require('node:child_process').spawnSync('python3', [
        '-B', ${JSON.stringify(path.join(root, "record-fixture.py"))}, ...process.argv.slice(index)
      ], {stdio:'inherit'});
      process.exit(result.status ?? 1);
    }
    else {
      const index=process.argv.indexOf('--ready-file');
      if(index>=0) fs.writeFileSync(process.argv[index+1],JSON.stringify({schemaVersion:1,startedAtUnixMs:Date.now(),chatId:-1001}));
      console.log('recorder done');
    }
  `,
    { mode: 0o755 },
  );
  const net = await import("node:net");
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const gatewayPort = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  childProcess.spawn = (command, argv, options) => {
    const child = originalSpawn(command, argv, options);
    children.push({ child, command, argv, options });
    if (argv.includes("dist/entry.js")) {
      observe("gateway-spawn", child);
      const command = options.env?.TELEGRAM_E2E_FOLLOWUP_CONTROL_COMMAND;
      if (command)
        watchers.push(
          fs.watch(path.dirname(command), () => {
            if (fs.existsSync(command)) observe("control-wait");
          }),
        );
    }
    if (argv.some((value) => String(value).endsWith("user-record.py")))
      child.once("exit", () => observe("recorder-terminated"));
    child.stdout?.on("data", (data) => {
      if (data.toString().includes("fixture blocked")) observe("mock-wait");
      if (data.toString().includes("recorder done")) observe("recorder-exit");
    });
    return child;
  };
  syncBuiltinESMExports();
  watchers.push(
    fs.watch(root, () => {
      if (fs.existsSync(path.join(root, "stop-requested"))) observe("restart-stop");
    }),
  );
  let getMeCount = 0;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname !== "api.telegram.org") return await originalFetch(url, init);
    const method = parsed.pathname.split("/").at(-1);
    if (method === "getMe" && ++getMeCount === 2 && mode === "body") {
      observedRequest = init.signal;
      const response = new Response(
        new ReadableStream({
          start(stream) {
            bodyController = stream;
          },
          pull() {
            bodyStarted.resolve();
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
      init.signal.addEventListener("abort", () => bodyController.error(init.signal.reason), {
        once: true,
      });
      headerBody.resolve(response);
      return response;
    }
    const result =
      method === "getMe"
        ? { id: 42, username: "sut_bot", can_read_all_group_messages: true }
        : method === "getChatMember"
          ? { status: "member" }
          : method === "getUpdates"
            ? []
            : { url: "", pending_update_count: 0 };
    return Response.json({ ok: true, result });
  };
  const credential = {
    driverEnv: { PATH: root + path.delimiter + process.env.PATH },
    groupId: "-1001",
    sutBotId: "42",
    sutUsername: "sut_bot",
    sutToken: "synthetic-token",
    testerUserId: "123",
    tdlibVersion: "1.8.67",
    whenLeaseUnhealthy: loss.promise,
    assertLeaseHealthy() {
      assert.equal(released, 0);
      if (!healthy) throw new Error("lease lost");
    },
    async release() {
      released += 1;
      observe("release");
    },
  };
  const actions =
    mode === "late"
      ? [{ type: "patchConfig", atMs: 0, patch: { messages: { responsePrefix: "test" } } }]
      : mode === "control"
        ? [{ type: "followupDrainWaitHeld", atMs: 0, timeoutMs: 60_000 }]
        : mode === "uncertain-send"
          ? [
              { type: "send", atMs: 0, text: "uncertain" },
              {
                type: "command",
                atMs: 200,
                argv: [
                  process.execPath,
                  "-e",
                  "require('node:fs').writeFileSync('later-side-effect', 'executed')",
                ],
                cwd: "repo",
                timeoutMs: 1000,
              },
              { type: "send", atMs: 300, text: "must not send" },
            ]
          : [{ type: "send", atMs: 0, text: "fixture" }];
  const run = runTelegramTestScenario({
    repoRoot: root,
    signal: controller.signal,
    acquireCredential: async () => credential,
    args: {
      backend: "mock",
      dm: true,
      chat: "",
      gatewayPort,
      mockPort: 1,
      sourceGateway: false,
      preSend: [],
      photos: [],
      text: "fixture",
      timeoutMs: 1000,
      record: path.join(root, "events"),
      output: path.join(root, "summary.json"),
      scenario: { actions },
    },
  });
  const outcome = run.then(
    (result) => ({ ok: true, result }),
    (error) => ({ ok: false, error }),
  );
  return {
    root,
    children,
    events,
    controller,
    outcome,
    wait,
    headerBody,
    bodyStarted,
    finishOldGatewayStop() {
      fs.writeFileSync(path.join(root, "release-stop"), "");
    },
    requestSignal: () => observedRequest,
    releaseCount: () => released,
    ignoreGatewayStop() {
      process.kill = (pid, signal) => {
        const gateway = children.find((entry) => entry.argv.includes("dist/entry.js"))?.child;
        if (gateway && pid === -gateway.pid && signal !== 0) return true;
        return originalKill(pid, signal);
      };
    },
    async cleanup() {
      process.kill = originalKill;
      controller.abort(new Error("fixture cleanup"));
      if (bodyController && !observedRequest?.aborted)
        bodyController.error(new Error("fixture cleanup"));
      for (const entry of children) {
        const command = entry.options.env?.TELEGRAM_E2E_FOLLOWUP_CONTROL_COMMAND;
        const status = entry.options.env?.TELEGRAM_E2E_FOLLOWUP_CONTROL_STATUS;
        if (command && status && fs.existsSync(command)) {
          const pending = JSON.parse(fs.readFileSync(command, "utf8"));
          fs.writeFileSync(status, JSON.stringify({ seq: pending.seq, status: "completed" }));
        }
        if (entry.child.pid) {
          try {
            originalKill(-entry.child.pid, "SIGKILL");
          } catch {}
        }
      }
      await outcome;
      for (const watcher of watchers) watcher.close();
      childProcess.spawn = originalSpawn;
      syncBuiltinESMExports();
      globalThis.fetch = originalFetch;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("run owner aborts the drive response body after headers", async () => {
  const f = await composition("body");
  try {
    const response = await deadline(f.headerBody.promise, "drive did not reach headers");
    await f.bodyStarted.promise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(response.body.locked, true);
    f.controller.abort(new Error("cancel body"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      f.requestSignal().aborted,
      true,
      "body transport must remain cancellation-owned after headers",
    );
    const result = await deadline(f.outcome, "body cancellation did not join");
    assert.equal(result.ok, false);
    assert.equal(f.releaseCount(), 1);
  } finally {
    await f.cleanup();
  }
});

test("run owner cancels provider startup before the banner deadline", async () => {
  const f = await composition("mock");
  try {
    await deadline(f.wait("mock-wait"), "provider did not reach startup");
    f.controller.abort(new Error("cancel startup"));
    const result = await deadline(f.outcome, "provider wait ignored run cancellation");
    assert.equal(result.ok, false);
    assert.equal(f.events.includes("gateway-spawn"), false);
    assert.equal(f.releaseCount(), 1);
    const config = JSON.parse(fs.readFileSync(path.join(f.root, "sut-config.json"), "utf8"));
    assert.equal(fs.existsSync(path.dirname(config.channels.telegram.tokenFile)), false);
  } finally {
    await f.cleanup();
  }
});

test("run owner cancels controls after recorder exit already won", async () => {
  const f = await composition("control");
  try {
    await deadline(
      Promise.all([f.wait("recorder-terminated"), f.wait("control-wait")]),
      "recorder exit/control join precondition missing",
    );
    await new Promise((resolve) => setImmediate(resolve));
    f.controller.abort(new Error("cancel control join"));
    const result = await deadline(f.outcome, "post-recorder control join ignored cancellation");
    assert.equal(result.ok, false);
    assert.equal(f.releaseCount(), 1);
  } finally {
    await f.cleanup();
  }
});

test("unconfirmed child termination cannot report clean release", async () => {
  const f = await composition("stop");
  try {
    f.ignoreGatewayStop();
    const result = await deadline(f.outcome, "teardown did not return its failure", 12_000);
    assert.equal(result.ok, false, "unconfirmed group stop must fail the run");
    assert.equal(f.releaseCount(), 0, "lease release must not precede proven child closure");
  } finally {
    await f.cleanup();
  }
});

test("closed run admission rejects a Gateway replacement after awaited stop", async () => {
  const f = await composition("late");
  try {
    await deadline(
      f.wait("restart-stop"),
      "configuration replacement did not reach old-child stop",
    );
    f.controller.abort(new Error("cancel replacement"));
    f.finishOldGatewayStop();
    const result = await deadline(
      f.outcome,
      "replacement cancellation did not finish",
      10000,
    ).catch((error) => ({ error }));
    assert.equal(
      f.events.filter((event) => event === "gateway-spawn").length,
      1,
      "no replacement child may start after run closure",
    );
    assert.equal(result.ok, false, "replacement cancellation must finish as a failed run");
  } finally {
    await f.cleanup();
  }
});

test("uninterrupted composition completes strict readiness and drive on one lease", async () => {
  const f = await composition("success");
  try {
    const result = await deadline(f.outcome, "positive composition did not complete", 10000);
    assert.equal(result.ok, true, String(result.error));
    assert.equal(f.releaseCount(), 1);
    const evidence = fs.readFileSync(path.join(f.root, "sut-config.json"), "utf8");
    const config = JSON.parse(evidence);
    assert.equal(Object.hasOwn(config.channels.telegram, "botToken"), false);
    assert.equal(evidence.includes("synthetic-token"), false);
    assert.equal(fs.existsSync(path.dirname(config.channels.telegram.tokenFile)), false);
    for (const { child, argv, options } of f.children) {
      assert.equal(Object.hasOwn(options.env, "TELEGRAM_BOT_TOKEN"), false);
      assert.equal(Object.hasOwn(options.env, "TELEGRAM_E2E_SUT_BOT_TOKEN"), false);
      assert.equal(JSON.stringify(options.env).includes("synthetic-token"), false);
      assert.equal(JSON.stringify(argv).includes("synthetic-token"), false);
      assert.equal(
        child.exitCode !== null || child.signalCode !== null,
        true,
        "every child must terminate before successful completion",
      );
    }
  } finally {
    await f.cleanup();
  }
});

test("uncertain recorder send fences later Node actions while recording incoming updates", async () => {
  const f = await composition("uncertain-send");
  try {
    const outcome = await deadline(f.outcome, "uncertain-send composition did not finish", 10000);
    assert.equal(outcome.ok, true, String(outcome.error));
    assert.equal(outcome.result.exitCode, 1);
    assert.equal(outcome.result.report.completed, false);
    assert.equal(fs.existsSync(path.join(f.root, "later-side-effect")), false);
    assert.equal(fs.readFileSync(path.join(f.root, "send-attempts"), "utf8"), "send");
    const events = fs
      .readFileSync(path.join(f.root, "events"), "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.deepEqual(
      events.map((event) => event.kind),
      ["action", "message"],
    );
    assert.equal(events[0].status, "failed");
    assert.equal(events[0].sendOutcome, "unknown");
    assert.equal(events[0].messageId, null);
    assert.match(events[0].error, /send confirmation/);
    assert.equal(events[1].text, "Late incoming observation");
    assert.ok(events[1].elapsedMs >= 200, "observation must outlast the blocked Node action");
    const summary = JSON.parse(fs.readFileSync(path.join(f.root, "summary.json"), "utf8"));
    assert.equal(summary.recordingComplete, true);
    assert.equal(summary.sentMessageId, null);
    assert.deepEqual(summary.sentMessageIds, []);
    assert.deepEqual(summary.sutRevisionTexts, ["Late incoming observation"]);
    assert.equal(summary.scenario.actionFailure.sendOutcome, "unknown");
    assert.equal(summary.scenario.actionFailure.actionIndex, 0);
    assert.deepEqual(summary.scenario.gatewayActions, []);
    assert.equal(f.releaseCount(), 1);
    for (const { child } of f.children) {
      assert.equal(child.exitCode !== null || child.signalCode !== null, true);
    }
  } finally {
    await f.cleanup();
  }
});
