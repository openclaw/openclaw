import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspect } from "node:util";
import { runTelegramTestScenario } from "./run-mock-sut-user-e2e.mjs";

// Bound hangs to the test instead of leaving the run alive.
const TEST_TIMEOUT_MS = 60_000;

function withinTest(work, signal, label) {
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(new Error(label, { cause: signal.reason }));
  });
  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }
  return Promise.race([work, aborted]).finally(() => {
    signal.removeEventListener("abort", onAbort);
  });
}

function childClosed(child) {
  return new Promise((resolve) => {
    child.once("close", (code, signal) => resolve([code, signal]));
    child.once("error", () => {
      if (!child.pid) resolve([]);
    });
  });
}

async function composition(context, mode, acquisitionReady = Promise.resolve()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-run-composition-"));
  context.after(() => fixture.cleanup(), { timeout: TEST_TIMEOUT_MS });
  const children = [];
  const events = [];
  const controller = new AbortController();
  const originalFetch = globalThis.fetch;
  const originalSpawn = childProcess.spawn;
  const originalWriteFileSync = fs.writeFileSync;
  const originalExistsSync = fs.existsSync;
  const originalKill = process.kill;
  let released = 0;
  const healthy = true;
  const loss = Promise.withResolvers();
  const headerBody = Promise.withResolvers();
  let bodyController;
  let observedRequest;
  const waiters = new Map();
  let baselineBarrier;
  let controlCommand;
  let listener;
  let outcome;
  let cleaning;
  const fixture = {
    cleanup() {
      return (cleaning ??= (async () => {
        process.kill = originalKill;
        try {
          controller.abort(new Error("fixture cleanup"));
          bodyController?.error(new Error("fixture cleanup"));
          for (const entry of children) {
            const command = entry.options.env?.TELEGRAM_E2E_FOLLOWUP_CONTROL_COMMAND;
            const status = entry.options.env?.TELEGRAM_E2E_FOLLOWUP_CONTROL_STATUS;
            if (command && status && fs.existsSync(command)) {
              const pending = JSON.parse(fs.readFileSync(command, "utf8"));
              fs.writeFileSync(status, JSON.stringify({ seq: pending.seq, status: "completed" }));
            }
          }
        } finally {
          for (const { child } of children) {
            if (child.pid) {
              try {
                originalKill(-child.pid, "SIGKILL");
              } catch (error) {
                if (error.code !== "ESRCH") child.kill("SIGKILL");
              }
            }
          }
          // Restore before any await: a child or run that never settles must not
          // leave patched globals for the next test. The aborted run spawns nothing.
          childProcess.spawn = originalSpawn;
          fs.writeFileSync = originalWriteFileSync;
          fs.existsSync = originalExistsSync;
          globalThis.fetch = originalFetch;
          syncBuiltinESMExports();
        }
        await Promise.all(children.map((entry) => entry.closed));
        if (listener?.listening) {
          await new Promise((resolve, reject) => {
            listener.close((/** @type {Error | undefined} */ error) =>
              error ? reject(error) : resolve(),
            );
          });
        }
        await outcome;
        fs.rmSync(root, { recursive: true, force: true });
      })());
    },
  };
  const observe = (name, value) => {
    events.push(name);
    waiters.get(name)?.resolve(value);
  };
  // Observe the runner's own writes; directory notifications can lag or disappear.
  fs.writeFileSync = (...args) => {
    const result = originalWriteFileSync(...args);
    if (args[0] === controlCommand) {
      observe("control-wait");
    }
    if (args[0] === path.join(root, "recorder.stderr.log")) {
      observe("recorder-logs-persisted");
    }
    return result;
  };
  if (mode === "late") {
    fs.existsSync = (pathname) => {
      const exists = originalExistsSync(pathname);
      if (pathname === baselineBarrier && !exists) {
        observe("baseline-wait");
      }
      return exists;
    };
  }
  if (mode === "success" && process.env.TELEGRAM_TEST_CONFINED === "1") {
    process.kill = (pid, signal) => {
      const gateway = children.find((entry) => entry.argv.includes("dist/entry.js"))?.child;
      if (gateway && pid === -gateway.pid && signal === 0 && !events.includes("group-eperm")) {
        observe("group-eperm");
        throw Object.assign(new Error("Group is awaiting reap"), { code: "EPERM" });
      }
      return originalKill(pid, signal);
    };
  }
  const wait = (name) => {
    if (events.includes(name)) {
      return Promise.resolve();
    }
    const waiter = Promise.withResolvers();
    waiters.set(name, waiter);
    return Promise.race([
      waiter.promise,
      outcome.then((result) => {
        if (!result.ok) {
          throw result.error;
        }
        throw new Error(`Telegram run completed before ${name}.`);
      }),
    ]);
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
    process.once('message', (_message, listener)=>{
      http.createServer((req,res)=>{res.end('{}')}).listen(listener, ()=>process.send('listening'));
    });
    if(${JSON.stringify(mode)}==='late') {
      process.once('SIGTERM',()=>process.send('stop-requested'));
      process.on('message', message=>{if(message==='release-stop') process.exit(0)});
    }
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

# The recorder's --seconds window runs on this clock, so host load cannot close
# it before the late update is read.
class Clock:
    now = time.time()
    def time(self):
        return self.now
    def sleep(self, seconds):
        self.now += seconds

clock = Clock()
record.time = clock

class Client:
    observed = False
    def next_update(self, timeout):
        clock.sleep(timeout)
        if self.observed:
            return None
        self.observed = True
        return {"@type": "updateNewMessage", "message": {
            "id": 42, "chat_id": 42, "date": int(clock.time()), "sender_id": {"user_id": 42},
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

# Admit Node controls only after the recorder's actual failure receipt is durable.
publish_ready = record.publish_recorder_ready
publish_state = record.publish_recorder_state
pending_ready = None

def defer_ready(*args):
    global pending_ready
    pending_ready = args

def publish_failure_then_ready(target, payload):
    publish_state(target, payload)
    if Path(target).name == "action-failure.json":
        publish_ready(*pending_ready)

record.publish_recorder_ready = defer_ready
record.publish_recorder_state = publish_failure_then_ready
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
      if(index>=0) {
        const ready=process.argv[index+1];
        fs.writeFileSync(ready+'.tmp',JSON.stringify({schemaVersion:1,startedAtUnixMs:Date.now(),chatId:-1001}));
        fs.renameSync(ready+'.tmp',ready);
      }
      if(${JSON.stringify(mode)}==='late') setInterval(()=>{},1000);
    }
  `,
    { mode: 0o755 },
  );
  listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await withinTest(once(listener, "listening"), context.signal, "gateway port did not listen");
  const gatewayPort = listener.address().port;
  const gatewayHandoff = Promise.withResolvers();
  void gatewayHandoff.promise.catch(() => {});
  childProcess.spawn = (command, argv, options) => {
    const isGateway = argv.includes("dist/entry.js");
    // The sandbox denies shared-temp ancestor metadata. Evaluate synthetic
    // child fixtures from their bytes so Node's entrypoint realpath does not
    // fail before reaching the runner's actual scenario boundary.
    const fixturePath =
      command === "uv"
        ? path.join(root, "uv")
        : ["dist/entry.js", "scripts/e2e/mock-openai-server.mjs"].includes(argv[0])
          ? path.join(root, argv[0])
          : undefined;
    const confined = process.env.TELEGRAM_TEST_CONFINED === "1" && fixturePath;
    const child = originalSpawn(
      confined ? process.execPath : command,
      confined
        ? [
            "-e",
            fs.readFileSync(fixturePath, "utf8").replace(/^#!.*\n/u, ""),
            ...(command === "uv" ? ["uv", ...argv] : argv),
          ]
        : argv,
      isGateway ? { ...options, stdio: [...options.stdio, "ipc"] } : options,
    );
    children.push({ child, command, argv, options, closed: childClosed(child) });
    if (isGateway) {
      // Transfer the bound socket without exposing a free-port gap to other tests.
      child.once("message", () => {
        listener.close((error) => {
          if (error) {
            gatewayHandoff.reject(error);
          } else {
            gatewayHandoff.resolve();
          }
        });
      });
      child.on("message", (message) => {
        if (message === "stop-requested") observe("restart-stop");
      });
      child.once("error", gatewayHandoff.reject);
      child.once("exit", (code, signal) =>
        gatewayHandoff.reject(
          new Error(`Gateway fixture exited before socket handoff: ${signal ?? code}`),
        ),
      );
      child.send("listen", listener, (error) => {
        if (error) {
          gatewayHandoff.reject(error);
        }
      });
      observe("gateway-spawn", child);
      controlCommand = options.env?.TELEGRAM_E2E_FOLLOWUP_CONTROL_COMMAND;
    }
    if (argv.some((value) => String(value).endsWith("user-record.py"))) {
      baselineBarrier = path.join(argv[argv.indexOf("--barrier-dir") + 1], "0");
    }
    child.stdout?.on("data", (data) => {
      if (data.toString().includes("fixture blocked")) {
        observe("mock-wait");
      }
    });
    return child;
  };
  syncBuiltinESMExports();
  let getMeCount = 0;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname === "127.0.0.1" && Number(parsed.port) === gatewayPort) {
      await gatewayHandoff.promise;
    }
    if (parsed.hostname !== "api.telegram.org") {
      return await originalFetch(url, init);
    }
    const method = parsed.pathname.split("/").at(-1);
    if (method === "getMe" && ++getMeCount === 2 && mode === "body") {
      observedRequest = init.signal;
      const response = new Response(
        new ReadableStream({
          start(stream) {
            bodyController = stream;
          },
          pull() {
            observe("body-started");
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
      init.signal.addEventListener("abort", () => bodyController.error(init.signal.reason), {
        once: true,
      });
      headerBody.resolve(response);
      observe("body-headers");
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
    // Runner scratch must land in the fixture root: an unconfirmed child stop
    // intentionally retains it for host reconciliation.
    driverEnv: { PATH: root + path.delimiter + process.env.PATH, TMPDIR: root },
    groupId: "-1001",
    sutBotId: "42",
    sutUsername: "sut_bot",
    sutToken: "synthetic-token",
    testerUserId: "123",
    tdlibVersion: "1.8.67",
    whenLeaseUnhealthy: loss.promise,
    assertLeaseHealthy() {
      assert.equal(released, 0);
      if (!healthy) {
        throw new Error("lease lost");
      }
    },
    async release() {
      released += 1;
      observe("release");
    },
  };
  const actions =
    mode === "late"
      ? [
          { type: "send", atMs: 0, text: "BEFORE", awaitReply: { text: "BEFORE" } },
          { type: "restartGateway", atMs: 0, graceMs: 15_000 },
        ]
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
    acquireCredential: async () => {
      await acquisitionReady;
      return credential;
    },
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
      // The test's own bound owns readiness hangs; host stalls can outlast the live 30 s budget.
      recorderReadyTimeoutMs: TEST_TIMEOUT_MS,
      record: path.join(root, "events"),
      output: path.join(root, "summary.json"),
      scenario: { actions },
    },
  });
  outcome = run.then(
    (result) => ({ ok: true, result }),
    (/** @type {unknown} */ error) => ({ ok: false, error }),
  );
  return Object.assign(fixture, {
    root,
    children,
    events,
    controller,
    outcome,
    wait,
    headerBody,
    releaseBaseline() {
      fs.writeFileSync(baselineBarrier, JSON.stringify({ sentMessageId: 10, messageId: 11 }));
    },
    finishOldGatewayStop() {
      children.find((entry) => entry.argv.includes("dist/entry.js")).child.send("release-stop");
    },
    requestSignal: () => observedRequest,
    releaseCount: () => released,
    ignoreGatewayStop() {
      process.kill = (pid, signal) => {
        const gateway = children.find((entry) => entry.argv.includes("dist/entry.js"))?.child;
        if (gateway && pid === -gateway.pid) {
          if (signal === 0) {
            throw Object.assign(new Error("Group probe denied"), { code: "EPERM" });
          }
          return true;
        }
        return originalKill(pid, signal);
      };
    },
  });
}

test(
  "run owner aborts the drive response body after headers",
  { timeout: TEST_TIMEOUT_MS },
  async (context) => {
    const f = await composition(context, "body");
    await withinTest(f.wait("body-headers"), context.signal, "drive did not reach headers");
    await withinTest(f.wait("body-started"), context.signal, "drive did not start the body");
    const response = await f.headerBody.promise;
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    assert.equal(response.body.locked, true);
    const cancellation = new Error("cancel body");
    f.controller.abort(cancellation);
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    assert.equal(
      f.requestSignal().aborted,
      true,
      "body transport must remain cancellation-owned after headers",
    );
    const result = await withinTest(f.outcome, context.signal, "body cancellation did not join");
    assert.equal(result.ok, false);
    assert.equal(result.error, cancellation, inspect(result.error, { depth: null }));
    assert.equal(f.releaseCount(), 1);
  },
);

test(
  "confined scenarios preserve readiness, uncertain-send fencing, and cleanup",
  { skip: process.platform !== "darwin", timeout: 2 * TEST_TIMEOUT_MS },
  async (context) => {
    const root = fs.mkdtempSync("/private/tmp/telegram-scenario-confinement-");
    let child;
    let closed;
    context.after(
      async () => {
        if (child?.pid && child.exitCode === null && child.signalCode === null) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch (error) {
            if (error.code !== "ESRCH") child.kill("SIGKILL");
          }
        }
        await closed;
        fs.rmSync(root, { recursive: true, force: true });
      },
      { timeout: TEST_TIMEOUT_MS },
    );
    const policy = path.join(root, "isolation.sb");
    fs.writeFileSync(
      policy,
      `(version 1)
(allow default)
(deny network*)
(allow network* (local ip "localhost:*") (remote ip "localhost:*"))
(deny file-write*)
(allow file-write* (subpath ${JSON.stringify(root)}))
(deny file-read* (require-all (subpath "/private/tmp") (require-not (subpath ${JSON.stringify(root)}))))
`,
    );
    child = childProcess.spawn(
      "/usr/bin/sandbox-exec",
      [
        "-f",
        policy,
        process.execPath,
        "--test",
        "--test-reporter=tap",
        "--test-name-pattern=^(uninterrupted composition|uncertain recorder send)",
        import.meta.filename,
      ],
      {
        detached: true,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          TMPDIR: root,
          PYTHONDONTWRITEBYTECODE: "1",
          TELEGRAM_TEST_CONFINED: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    closed = childClosed(child);
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const [code, signal] = await withinTest(
      closed,
      context.signal,
      "confined composition did not finish",
    );
    assert.equal(signal, null);
    assert.equal(code, 0, output.replaceAll(root, "<owned-root>"));
    assert.match(output, /^# tests 2$/mu);
    assert.deepEqual(fs.readdirSync(root), ["isolation.sb"]);
  },
);

test(
  "run owner cancels provider startup before the banner deadline",
  { timeout: TEST_TIMEOUT_MS },
  async (context) => {
    const f = await composition(context, "mock");
    await withinTest(f.wait("mock-wait"), context.signal, "provider did not reach startup");
    const cancellation = new Error("cancel startup");
    f.controller.abort(cancellation);
    const result = await withinTest(
      f.outcome,
      context.signal,
      "provider wait ignored run cancellation",
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, cancellation, inspect(result.error, { depth: null }));
    await assert.rejects(
      Promise.race([
        f.wait("restart-stop"),
        new Promise((resolve) => {
          setImmediate(resolve);
        }),
      ]),
      (error) => error === result.error,
    );
    assert.equal(f.events.includes("gateway-spawn"), false);
    assert.equal(f.releaseCount(), 1);
    const config = JSON.parse(fs.readFileSync(path.join(f.root, "sut-config.json"), "utf8"));
    assert.equal(fs.existsSync(path.dirname(config.channels.telegram.tokenFile)), false);
  },
);

test(
  "run owner cancels controls after recorder exit already won",
  { timeout: TEST_TIMEOUT_MS },
  async (context) => {
    const f = await composition(context, "control");
    await withinTest(
      Promise.all([f.wait("recorder-logs-persisted"), f.wait("control-wait")]),
      context.signal,
      "recorder exit/control join precondition missing",
    );
    const cancellation = new Error("cancel control join");
    f.controller.abort(cancellation);
    const result = await withinTest(
      f.outcome,
      context.signal,
      "post-recorder control join ignored cancellation",
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, cancellation, inspect(result.error, { depth: null }));
    assert.equal(f.releaseCount(), 1);
  },
);

test(
  "unconfirmed child termination cannot report clean release",
  { timeout: TEST_TIMEOUT_MS },
  async (context) => {
    const f = await composition(context, "stop");
    f.ignoreGatewayStop();
    const result = await withinTest(
      f.outcome,
      context.signal,
      "teardown did not return its failure",
    );
    assert.equal(result.ok, false, "unconfirmed group stop must fail the run");
    assert.match(inspect(result.error, { depth: null }), /Telegram process group did not stop:/u);
    assert.equal(f.releaseCount(), 0, "lease release must not precede proven child closure");
  },
);

test(
  "restart waits for the visible baseline and rejects replacement after run closure",
  { timeout: TEST_TIMEOUT_MS },
  async (context) => {
    const acquisition = Promise.withResolvers();
    context.after(() => acquisition.resolve());
    const f = await composition(context, "late", acquisition.promise);
    let stopped = false;
    const restartStop = f.wait("restart-stop").then(() => {
      stopped = true;
    });
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    assert.equal(stopped, false);
    assert.equal(f.children.length, 0, "setup must wait for credential acquisition");
    acquisition.resolve();
    await withinTest(
      Promise.race([
        f.wait("baseline-wait"),
        restartStop.then(() => {
          throw new Error("Gateway stopped before visible baseline");
        }),
      ]),
      context.signal,
      "runner did not wait for the baseline",
    );
    assert.equal(stopped, false);
    f.releaseBaseline();
    await withinTest(restartStop, context.signal, "gateway did not request restart stop");
    const cancellation = new Error("cancel replacement");
    f.controller.abort(cancellation);
    f.finishOldGatewayStop();
    const result = await withinTest(
      f.outcome,
      context.signal,
      "replacement cancellation did not finish",
    );
    assert.equal(
      f.events.filter((event) => event === "gateway-spawn").length,
      1,
      "no replacement child may start after run closure",
    );
    assert.equal(result.ok, false, "replacement cancellation must finish as a failed run");
    assert.equal(result.error, cancellation, inspect(result.error, { depth: null }));
  },
);

test(
  "uninterrupted composition completes strict readiness and drive on one lease",
  { timeout: TEST_TIMEOUT_MS },
  async (context) => {
    const f = await composition(context, "success");
    const result = await withinTest(
      f.outcome,
      context.signal,
      "positive composition did not complete",
    );
    assert.equal(result.ok, true, inspect(result.error, { depth: null }));
    if (process.env.TELEGRAM_TEST_CONFINED === "1") {
      assert.equal(f.events.includes("group-eperm"), true);
    }
    assert.equal(f.events.includes("gateway-spawn"), true);
    await assert.rejects(
      Promise.race([
        f.wait("restart-stop"),
        new Promise((resolve) => {
          setImmediate(resolve);
        }),
      ]),
      /Telegram run completed before restart-stop/,
    );
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
      assert.throws(() => process.kill(-child.pid, 0), { code: "ESRCH" });
    }
  },
);

test(
  "uncertain recorder send fences later Node actions while recording incoming updates",
  { timeout: TEST_TIMEOUT_MS },
  async (context) => {
    const f = await composition(context, "uncertain-send");
    const outcome = await withinTest(
      f.outcome,
      context.signal,
      "uncertain-send composition did not finish",
    );
    assert.equal(outcome.ok, true, inspect(outcome.error, { depth: null }));
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
  },
);
