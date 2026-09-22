import assert from "node:assert/strict";
import test from "node:test";
import { runTelegramTestScenario } from "./run-mock-sut-user-e2e.mjs";
import { checkTelegramTestCredential } from "./telegram-test-doctor.mjs";

function fixture() {
  let released = 0;
  let healthy = true;
  let revoke;
  let proxyClosed = false;
  const credential = {
    driverEnv: {},
    groupId: "-1001",
    sutBotId: "42",
    sutToken: "synthetic-token",
    sutUsername: "sut_bot",
    tdlibVersion: "1.8.67",
    testerUserId: "123",
    whenLeaseUnhealthy: new Promise((resolve) => {
      revoke = resolve;
    }),
    assertLeaseHealthy() {
      assert.equal(released, 0, "released credentials cannot authorize work");
      if (!healthy) throw new Error("lease revoked");
    },
    async release() {
      released += 1;
    },
  };
  const options = {
    runCommandImpl: async (_command, args) => ({
      status: 0,
      timedOut: false,
      stdout: JSON.stringify(
        args.includes("prepare-group")
          ? {
              ok: true,
              groupId: "-2042",
              status: "created",
            }
          : args.includes("cleanup-group")
            ? {
                ok: true,
                groupId: "-2042",
                status: "deleted",
              }
            : {
                ok: true,
                authorized: true,
                ...(args.includes("--require-chat") ? { chatId: -1001 } : {}),
                testerGroupWriteAccess: true,
                testDc: true,
                tdlibVersion: "1.8.67",
                user: { id: 123 },
                chatId: -1001,
              },
      ),
    }),
    startProxy: async () => ({
      apiRoot: "http://127.0.0.1:1",
      close: async () => {
        proxyClosed = true;
      },
    }),
    fetchImpl: async (url) =>
      new URL(url).pathname.endsWith("/getChat")
        ? Response.json(
            { ok: false, error_code: 400, description: "Bad Request: chat not found" },
            { status: 400 },
          )
        : Response.json({
            ok: true,
            result: new URL(url).pathname.endsWith("/getMe")
              ? { id: 42, username: "sut_bot", can_read_all_group_messages: true }
              : { status: "member" },
          }),
  };
  return {
    credential,
    options,
    releaseCount: () => released,
    proxyClosed: () => proxyClosed,
    revoke() {
      healthy = false;
      revoke(new Error("lease revoked"));
    },
    check: (actual, { signal, args }) =>
      checkTelegramTestCredential({
        credential: actual,
        signal,
        dm: args?.dm,
        chat: args?.chat,
        requireForum: args?.scenario?.actions.some((action) => action.forumTopicId !== undefined),
        ...options,
      }),
  };
}

test("scenario drives the same ready credential before its only release", async () => {
  const f = fixture();
  let acquisitions = 0;
  let delivered = false;
  await runTelegramTestScenario({
    acquireCredential: async () => {
      acquisitions += 1;
      return f.credential;
    },
    checkCredential: f.check,
    driveScenario: async (_args, _root, credential) => {
      assert.equal(credential, f.credential);
      credential.assertLeaseHealthy();
      assert.equal(f.proxyClosed(), true);
      delivered = true;
    },
  });
  assert.equal(delivered, true);
  assert.equal(acquisitions, 1);
  assert.equal(f.releaseCount(), 1);
});

test("scenario provisions a fresh group when the stored group is unusable and removes it before release", async () => {
  const f = fixture();
  const events = [];
  let groupExists = false;
  const command = f.options.runCommandImpl;
  f.options.runCommandImpl = async (name, args) => {
    if (args.includes("prepare-group")) {
      groupExists = true;
      events.push("created");
    } else if (args.includes("cleanup-group")) {
      groupExists = false;
      events.push("deleted");
    }
    return await command(name, args);
  };
  const fetch = f.options.fetchImpl;
  f.options.fetchImpl = async (url, init) => {
    if (!new URL(url).pathname.endsWith("/getChatMember")) return await fetch(url, init);
    const request = JSON.parse(init.body);
    return Response.json({
      ok: true,
      result: { status: groupExists && request.chat_id === "-2042" ? "member" : "left" },
    });
  };
  const release = f.credential.release;
  f.credential.release = async () => {
    assert.equal(groupExists, false, "group must be deleted before releasing its credential");
    events.push("released");
    await release();
  };
  await runTelegramTestScenario({
    acquireCredential: async () => f.credential,
    checkCredential: f.check,
    driveScenario: async (_args, _root, credential) => {
      assert.equal(credential.groupId, "-2042");
      assert.equal(groupExists, true);
      events.push("delivered");
    },
  });
  assert.deepEqual(events, ["created", "delivered", "deleted", "released"]);
  assert.equal(f.releaseCount(), 1);
});

test("DM reaches its SUT with an unusable group and group privacy enabled", async () => {
  const f = fixture();
  const commands = [];
  const command = f.options.runCommandImpl;
  f.options.runCommandImpl = async (name, args) => {
    commands.push(args.includes("status") ? "status" : "group-operation");
    if (!args.includes("status")) throw new Error("DM must not mutate a group");
    assert.equal(args.includes("--require-chat"), false);
    return await command(name, args);
  };
  f.options.fetchImpl = async (url) => {
    assert.equal(new URL(url).pathname.split("/").at(-1), "getMe");
    return Response.json({
      ok: true,
      result: { id: 42, username: "sut_bot", can_read_all_group_messages: false },
    });
  };
  let delivered = false;
  await runTelegramTestScenario({
    args: { dm: true },
    acquireCredential: async () => f.credential,
    checkCredential: f.check,
    driveScenario: async (args, _root, credential) => {
      assert.equal(args.dm, true);
      assert.equal(credential.sutBotId, "42");
      delivered = true;
    },
  });
  assert.equal(delivered, true);
  assert.deepEqual(commands, ["status"]);
  assert.equal(f.releaseCount(), 1);
  assert.equal(f.credential.testGroup, undefined);
});

for (const selector of [
  "-1002042",
  "@qa_forum",
  "https://t.me/qa_forum",
  "https://t.me/+qa-invite",
  "tg://join?invite=qa-invite",
]) {
  test(`explicit forum selector ${selector} is resolved and preserved`, async () => {
    const f = fixture();
    const membershipTargets = [];
    const command = f.options.runCommandImpl;
    f.options.runCommandImpl = async (name, args) => {
      if (args.includes("resolve-chat")) {
        assert.equal(args[args.indexOf("--chat") + 1], selector);
        return {
          status: 0,
          timedOut: false,
          stdout: JSON.stringify({
            ok: true,
            chatId: "-1002042",
            isForum: true,
            type: { "@type": "chatTypeSupergroup", supergroup_id: 2042, is_channel: false },
          }),
        };
      }
      assert.ok(args.includes("status"), "a ready forum must not create or delete a basic group");
      assert.equal(args.includes("--require-chat"), false);
      return await command(name, args);
    };
    const fetch = f.options.fetchImpl;
    f.options.fetchImpl = async (url, init) => {
      const method = new URL(url).pathname.split("/").at(-1);
      if (method === "getChat") {
        assert.equal(JSON.parse(init.body).chat_id, "-1002042");
        return Response.json({
          ok: true,
          result: { id: -1002042, type: "supergroup", is_forum: true },
        });
      }
      if (method === "getChatMember") {
        membershipTargets.push(JSON.parse(init.body).chat_id);
        return Response.json({ ok: true, result: { status: "member" } });
      }
      return await fetch(url, init);
    };
    let delivered = false;
    await runTelegramTestScenario({
      args: {
        chat: selector,
        dm: false,
        scenario: { actions: [{ type: "send", atMs: 0, text: "topic", forumTopicId: 42 }] },
      },
      acquireCredential: async () => f.credential,
      checkCredential: f.check,
      driveScenario: async (args, _root, credential) => {
        assert.equal(args.chat, selector);
        assert.equal(credential.groupId, "-1002042");
        assert.equal(credential.chatTarget.recorderSelector, "-1002042");
        delivered = true;
      },
    });
    assert.equal(delivered, true);
    assert.deepEqual(membershipTargets, ["-1002042"]);
    assert.equal(f.credential.testGroup, undefined);
    assert.equal(f.releaseCount(), 1);
  });
}

test("an inaccessible explicit group stops without substituting the stored group", async () => {
  const f = fixture();
  const command = f.options.runCommandImpl;
  f.options.runCommandImpl = async (name, args) => {
    if (args.includes("prepare-group"))
      return { status: 1, timedOut: false, stderr: "QA user cannot invite the bot" };
    if (args.includes("cleanup-group"))
      return {
        status: 0,
        timedOut: false,
        stdout: JSON.stringify({ ok: true, status: "not-created" }),
      };
    if (args.includes("resolve-chat"))
      return {
        status: 0,
        timedOut: false,
        stdout: JSON.stringify({
          ok: true,
          chatId: "-3000",
          type: { "@type": "chatTypeBasicGroup", basic_group_id: 3000 },
        }),
      };
    assert.ok(args.includes("status"));
    return await command(name, args);
  };
  await assert.rejects(
    runTelegramTestScenario({
      args: { chat: "-3000" },
      acquireCredential: async () => f.credential,
      checkCredential: f.check,
      driveScenario: async () => assert.fail("unready explicit target must not drive"),
    }),
    /QA user cannot invite/,
  );
  assert.equal(f.credential.groupId, "-1001");
  assert.equal(f.releaseCount(), 1);
});

for (const inaccessible of [true, false]) {
  test(`explicit forum repairs missing membership when bot access is ${inaccessible ? "unavailable" : "readable"}`, async () => {
    const f = fixture();
    let member = false;
    const events = [];
    const command = f.options.runCommandImpl;
    f.options.runCommandImpl = async (name, args) => {
      if (args.includes("resolve-chat"))
        return {
          status: 0,
          stdout: JSON.stringify({
            ok: true,
            chatId: "-10042",
            type: { "@type": "chatTypeSupergroup", supergroup_id: 42 },
          }),
        };
      if (args.includes("prepare-group")) {
        assert.equal(
          args[args.indexOf("--chat") + 1],
          "-10042",
          "repair must keep the selected forum",
        );
        member = true;
        events.push("member-added");
        return {
          status: 0,
          stdout: JSON.stringify({ ok: true, groupId: "-10042", status: "membership-added" }),
        };
      }
      if (args.includes("cleanup-group")) {
        member = false;
        events.push("member-removed");
        return {
          status: 0,
          stdout: JSON.stringify({ ok: true, groupId: "-10042", status: "membership-removed" }),
        };
      }
      return await command(name, args);
    };
    const fetch = f.options.fetchImpl;
    f.options.fetchImpl = async (url, init) => {
      const method = new URL(url).pathname.split("/").at(-1);
      if (method === "getChat")
        return inaccessible && !member
          ? Response.json({ ok: false, error_code: 400 }, { status: 400 })
          : Response.json({ ok: true, result: { id: -10042, type: "supergroup", is_forum: true } });
      if (method === "getChatMember")
        return Response.json({ ok: true, result: { status: member ? "member" : "left" } });
      return await fetch(url, init);
    };
    const release = f.credential.release;
    f.credential.release = async () => {
      assert.equal(member, false);
      events.push("released");
      await release();
    };
    await runTelegramTestScenario({
      args: { chat: "https://t.me/qa_forum" },
      acquireCredential: async () => f.credential,
      checkCredential: f.check,
      driveScenario: async (_args, _root, credential) => {
        assert.equal(member, true);
        assert.equal(credential.chatTarget.recorderSelector, "-10042");
        events.push("delivered");
      },
    });
    assert.deepEqual(events, ["member-added", "delivered", "member-removed", "released"]);
  });
}

test("explicit SUT private chat follows the DM route without group checks", async () => {
  const f = fixture();
  const command = f.options.runCommandImpl;
  f.options.runCommandImpl = async (name, args) => {
    if (args.includes("resolve-chat"))
      return {
        status: 0,
        timedOut: false,
        stdout: JSON.stringify({
          ok: true,
          chatId: "42",
          type: { "@type": "chatTypePrivate", user_id: 42 },
        }),
      };
    assert.ok(args.includes("status"));
    return await command(name, args);
  };
  const fetch = f.options.fetchImpl;
  f.options.fetchImpl = async (url, init) => {
    assert.ok(new URL(url).pathname.endsWith("/getMe"));
    return await fetch(url, init);
  };
  let delivered = false;
  await runTelegramTestScenario({
    args: { chat: "https://t.me/sut_bot" },
    acquireCredential: async () => f.credential,
    checkCredential: f.check,
    driveScenario: async (_args, _root, credential) => {
      assert.deepEqual(credential.chatTarget, {
        kind: "dm",
        recorderSelector: "42",
        cronDeliveryTarget: "123",
      });
      delivered = true;
    },
  });
  assert.equal(delivered, true);
  assert.equal(f.releaseCount(), 1);
});

test("a forum topic cannot silently target an ordinary explicit group", async () => {
  const f = fixture();
  const command = f.options.runCommandImpl;
  f.options.runCommandImpl = async (name, args) => {
    if (args.includes("resolve-chat"))
      return {
        status: 0,
        stdout: JSON.stringify({
          ok: true,
          chatId: "-3000",
          type: { "@type": "chatTypeBasicGroup", basic_group_id: 3000 },
          isForum: false,
        }),
      };
    assert.ok(args.includes("status"));
    return await command(name, args);
  };
  const fetch = f.options.fetchImpl;
  f.options.fetchImpl = async (url, init) =>
    new URL(url).pathname.endsWith("/getChat")
      ? Response.json({ ok: true, result: { id: -3000, type: "group" } })
      : await fetch(url, init);
  await assert.rejects(
    runTelegramTestScenario({
      args: {
        chat: "-3000",
        scenario: { actions: [{ type: "send", atMs: 0, text: "topic", forumTopicId: 42 }] },
      },
      acquireCredential: async () => f.credential,
      checkCredential: f.check,
      driveScenario: async () => assert.fail("ordinary group cannot prove a forum topic"),
    }),
    /not a forum/,
  );
  assert.equal(f.releaseCount(), 1);
});

for (const status of ["left", "kicked", "restricted"]) {
  test(`strict membership ${status} prevents product delivery`, async () => {
    const f = fixture();
    const fetch = f.options.fetchImpl;
    f.options.fetchImpl = (url) =>
      new URL(url).pathname.endsWith("/getChatMember")
        ? Promise.resolve(Response.json({ ok: true, result: { status } }))
        : fetch(url);
    let delivered = false;
    await assert.rejects(
      runTelegramTestScenario({
        acquireCredential: async () => f.credential,
        checkCredential: f.check,
        driveScenario: async () => {
          delivered = true;
        },
      }),
      /not an active member/u,
    );
    assert.equal(delivered, false);
    assert.equal(f.proxyClosed(), true);
    assert.equal(f.releaseCount(), 1);
  });
}

for (const failure of ["revocation", "cancellation"]) {
  test(`${failure} after readiness prevents product delivery`, async () => {
    const f = fixture();
    const controller = new AbortController();
    let delivered = false;
    await assert.rejects(
      runTelegramTestScenario({
        signal: controller.signal,
        acquireCredential: async () => f.credential,
        checkCredential: async (credential, options) => {
          await f.check(credential, options);
          if (failure === "revocation") f.revoke();
          else controller.abort(new Error("cancelled"));
        },
        driveScenario: async () => {
          delivered = true;
        },
      }),
      failure === "revocation"
        ? (error) => error instanceof AggregateError && error.errors[0].message === "lease revoked"
        : /cancelled/u,
    );
    assert.equal(delivered, false);
    assert.equal(f.releaseCount(), failure === "revocation" ? 0 : 1);
    assert.equal(
      f.credential.testGroup.cleanup.status,
      failure === "revocation" ? "failed" : "deleted",
    );
  });
}

test("cancelled scenario does not acquire a credential", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  let acquisitions = 0;
  await assert.rejects(
    runTelegramTestScenario({
      signal: controller.signal,
      acquireCredential: async () => {
        acquisitions += 1;
      },
    }),
    /cancelled/u,
  );
  assert.equal(acquisitions, 0);
});

test("cancellation interrupts pending readiness HTTP and closes before release", async () => {
  const f = fixture();
  const controller = new AbortController();
  let started;
  const pending = new Promise((resolve) => {
    started = resolve;
  });
  f.options.fetchImpl = async (_url, { signal }) => {
    started();
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    throw signal.reason;
  };
  let delivered = false;
  const run = runTelegramTestScenario({
    signal: controller.signal,
    acquireCredential: async () => f.credential,
    checkCredential: f.check,
    driveScenario: async () => {
      delivered = true;
    },
  });
  await pending;
  controller.abort(new Error("cancelled HTTP"));
  await assert.rejects(run, /cancelled HTTP/u);
  assert.equal(delivered, false);
  assert.equal(f.proxyClosed(), true);
  assert.equal(f.releaseCount(), 1);
});

test("driver failure keeps the lease until driver cleanup finishes", async () => {
  const f = fixture();
  let driverClosed = false;
  const release = f.credential.release;
  f.credential.release = async () => {
    assert.equal(driverClosed, true);
    await release();
  };
  await assert.rejects(
    runTelegramTestScenario({
      acquireCredential: async () => f.credential,
      checkCredential: f.check,
      driveScenario: async () => {
        try {
          throw new Error("driver failed");
        } finally {
          f.credential.assertLeaseHealthy();
          driverClosed = true;
        }
      },
    }),
    /driver failed/u,
  );
  assert.equal(f.releaseCount(), 1);
});

test("SIGTERM during CLI readiness closes its proxy before the sole lease release", async (context) => {
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-signal-owner-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "scripts/e2e"), { recursive: true });
  fs.writeFileSync(path.join(root, "scripts/e2e/mock-openai-server.mjs"), "");
  const trace = path.join(root, "trace.jsonl");
  const credentialModule = `
    import fs from 'node:fs';
    export async function acquireTelegramTestCredential() {
      return {whenLeaseUnhealthy:new Promise(()=>{}),assertLeaseHealthy(){}, async release(){fs.appendFileSync(${JSON.stringify(trace)}, 'release\\n')}};
    }`;
  const readinessModule = `
    import fs from 'node:fs';
    export async function checkTelegramTestCredential({signal}) {
      const keepAlive=setInterval(()=>{},1000);
      try {
        process.stdout.write('readiness started\\n');
        await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
        signal.throwIfAborted();
      } finally {
        await new Promise(resolve=>setImmediate(resolve));
        clearInterval(keepAlive);
        fs.appendFileSync(${JSON.stringify(trace)}, 'proxy closed\\n');
      }
    }`;
  fs.writeFileSync(
    path.join(root, "preload.mjs"),
    `
    import {registerHooks} from 'node:module';
    registerHooks({load(url,context,next){
      if(url.endsWith('/telegram-test-credential.mjs')) return {format:'module',shortCircuit:true,source:${JSON.stringify(credentialModule)}};
      if(url.endsWith('/telegram-test-doctor.mjs')) return {format:'module',shortCircuit:true,source:${JSON.stringify(readinessModule)}};
      return next(url,context);
    }});`,
  );
  const child = spawn(
    process.execPath,
    [
      "--import",
      path.join(root, "preload.mjs"),
      new URL("./run-mock-sut-user-e2e.mjs", import.meta.url).pathname,
      "--dm",
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
  context.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  const completion = once(child, "exit");
  const first = await Promise.race([
    once(child.stdout, "data").then(([output]) => output.toString()),
    completion.then(([code]) => {
      throw new Error(`CLI exited before readiness: ${code}`);
    }),
  ]);
  assert.match(first, /readiness started/u);
  child.kill("SIGTERM");
  const [code, signal] = await completion;
  assert.equal(code, 143);
  assert.equal(signal, null);
  assert.equal(fs.readFileSync(trace, "utf8"), "proxy closed\nrelease\n");
});

test("scenario cancellation aborts a pending request in the real drive path", async (context) => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-drive-cancel-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, "uv"),
    `#!${process.execPath}\nconsole.log(JSON.stringify({ok:true,user:{id:123}}));\n`,
    { mode: 0o755 },
  );
  const f = fixture();
  f.credential.driverEnv.PATH = root + path.delimiter + process.env.PATH;
  const controller = new AbortController();
  const requested = Promise.withResolvers();
  const response = Promise.withResolvers();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, { signal }) => {
    requested.resolve(signal);
    signal.addEventListener("abort", () => response.reject(signal.reason), { once: true });
    return await response.promise;
  };
  const run = runTelegramTestScenario({
    args: { dm: true },
    repoRoot: root,
    signal: controller.signal,
    acquireCredential: async () => f.credential,
    checkCredential: async () => ({ ok: true }),
  });
  const rejected = run.catch((error) => error);
  try {
    const requestSignal = await requested.promise;
    controller.abort(new Error("cancelled drive"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      requestSignal.aborted,
      true,
      "active drive request must be aborted before lease release",
    );
    assert.match(String(await rejected), /cancelled drive/u);
  } finally {
    response.reject(new Error("test teardown"));
    await rejected;
    globalThis.fetch = originalFetch;
  }
  assert.equal(f.releaseCount(), 1);
});

for (const event of ["caller cancellation", "lease loss"]) {
  test(`${event} during readiness proxy cleanup rejects the completed doctor result`, async () => {
    const { runTelegramTestDoctor } = await import("./telegram-test-doctor.mjs");
    const f = fixture();
    const closing = Promise.withResolvers();
    const finish = Promise.withResolvers();
    const controller = new AbortController();
    const start = f.options.startProxy;
    f.options.startProxy = async () => {
      const proxy = await start();
      return {
        ...proxy,
        close: async () => {
          closing.resolve();
          await finish.promise;
          await proxy.close();
        },
      };
    };
    const run = runTelegramTestDoctor({
      acquireCredential: async () => f.credential,
      dm: false,
      signal: controller.signal,
      ...f.options,
    });
    await closing.promise;
    if (event === "caller cancellation")
      controller.abort(new Error("cancelled during proxy close"));
    else f.revoke();
    finish.resolve();
    await assert.rejects(
      run,
      event === "lease loss"
        ? (error) => error instanceof AggregateError && error.errors[0].message === "lease revoked"
        : /cancelled during proxy close/u,
    );
    assert.equal(f.proxyClosed(), true);
    assert.equal(f.releaseCount(), event === "lease loss" ? 0 : 1);
    assert.equal(
      f.credential.testGroup.cleanup.status,
      event === "lease loss" ? "failed" : "deleted",
    );
  });

  test(`${event} during final release cannot become a successful scenario`, async () => {
    const f = fixture();
    const releasing = Promise.withResolvers();
    const finish = Promise.withResolvers();
    const controller = new AbortController();
    const release = f.credential.release;
    f.credential.release = async () => {
      releasing.resolve();
      await finish.promise;
      await release();
    };
    const run = runTelegramTestScenario({
      acquireCredential: async () => f.credential,
      checkCredential: f.check,
      signal: controller.signal,
      driveScenario: async () => "completed work",
    });
    await releasing.promise;
    if (event === "caller cancellation") controller.abort(new Error("cancelled during release"));
    else f.revoke();
    finish.resolve();
    await assert.rejects(run, /cancelled during release|lease revoked/u);
    assert.equal(f.releaseCount(), 1);
  });
}

test("selected-group tester permissions prevent delivery even when bot membership is ready", async () => {
  const f = fixture();
  const command = f.options.runCommandImpl;
  f.options.runCommandImpl = async (name, args) => {
    if (args.includes("--check-chat")) {
      assert.equal(args[args.indexOf("--check-chat") + 1], "-2042");
      return {
        status: 0,
        timedOut: false,
        stdout: JSON.stringify({ ok: true, testerGroupWriteAccess: false }),
      };
    }
    return await command(name, args);
  };
  await assert.rejects(
    runTelegramTestScenario({
      acquireCredential: async () => f.credential,
      checkCredential: f.check,
      driveScenario: async () => assert.fail("a denied tester must not send"),
    }),
    /selected group membership and text permission/,
  );
  assert.equal(f.credential.testGroup.cleanup.status, "deleted");
  assert.equal(f.releaseCount(), 1);
});
