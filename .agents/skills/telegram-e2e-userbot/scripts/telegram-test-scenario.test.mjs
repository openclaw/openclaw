import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runTelegramTestScenario } from "./run-mock-sut-user-e2e.mjs";
import { currentTelegramRun } from "./telegram-run-scope.mjs";
import { checkTelegramTestCredential } from "./telegram-test-doctor.mjs";

function fixture() {
  let released = 0;
  let healthy = true;
  let revoke;
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
      if (!healthy) {
        throw new Error("lease revoked");
      }
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
                testerGroupWriteAccess: true,
                testDc: true,
                tdlibVersion: "1.8.67",
                user: { id: 123 },
                chatId: -1001,
              },
      ),
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
        createForum: args?.createForum,
        ...options,
      }),
  };
}

test("failed readiness retains only structural diagnostics after credential cleanup", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-readiness-evidence-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = fixture();
  const privateState = path.join(root, "private-state");
  f.credential.testerUserId = "87654321098765";
  fs.mkdirSync(privateState);
  const raw = `python: realpath: ${privateState}/uv-cache/bin: Operation not permitted ${f.credential.sutToken} ${f.credential.testerUserId} unknown-private-value`;
  f.options.runCommandImpl = async () => ({
    status: 1,
    timedOut: false,
    stdout: "private stdout",
    stderr: raw,
  });
  const release = f.credential.release.bind(f.credential);
  f.credential.release = async () => {
    fs.rmSync(privateState, { recursive: true });
    await release();
  };
  await assert.rejects(
    runTelegramTestScenario({
      args: { dm: true, output: path.join(root, "proof", "summary.json") },
      acquireCredential: async () => f.credential,
      checkCredential: f.check,
      driveScenario: async () => assert.fail("readiness failure cannot start Gateway or messages"),
    }),
    /TDLib readiness failed/,
  );
  assert.equal(f.releaseCount(), 1);
  assert.equal(fs.existsSync(privateState), false);
  const file = path.join(root, "proof", "readiness.json");
  const evidence = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(evidence.phase, "tdlib-status");
  assert.equal(evidence.exitCode, 1);
  assert.equal(evidence.timedOut, false);
  assert.equal(evidence.stderrBytes, Buffer.byteLength(raw));
  assert.deepEqual(evidence.signals, ["permission-denied", "path-resolution"]);
  assert.equal(Number.isFinite(evidence.durationMs), true);
  const publicText = JSON.stringify(evidence);
  for (const privateValue of [
    privateState,
    f.credential.sutToken,
    f.credential.testerUserId,
    "unknown-private-value",
    "private stdout",
  ]) {
    assert.equal(publicText.includes(privateValue), false);
  }
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

for (const verified of [false, true]) {
  test(`scenario cleanup honors the Gateway verified=${verified} receipt before deleting recovery state`, async (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-cleanup-receipt-"));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const f = fixture();
    const recovery = path.join(root, "lease.json");
    fs.writeFileSync(recovery, "synthetic recovery", { mode: 0o600 });
    let stops = 0;
    const release = f.credential.release.bind(f.credential);
    f.credential.release = async () => {
      fs.unlinkSync(recovery);
      await release();
    };
    const result = runTelegramTestScenario({
      acquireCredential: async () => f.credential,
      checkCredential: async () => {},
      driveScenario: async () => {
        const scope = currentTelegramRun();
        const scratch = path.join(root, "gateway");
        fs.mkdirSync(scratch);
        scope.ownScratch(scratch, () => fs.rmSync(scratch, { recursive: true }));
        const gateway = scope.ownProxy({
          async close() {
            stops++;
            return { verified };
          },
        });
        await scope.closeProxy(gateway);
      },
    });
    if (verified) {
      await result;
    } else {
      await assert.rejects(result, /cleanup|unconfirmed/);
    }
    assert.equal(stops, 1);
    assert.equal(f.releaseCount(), verified ? 1 : 0);
    assert.equal(fs.existsSync(recovery), !verified);
  });
}

test("scenario provisions a fresh group when the stored group is unusable and removes it before release", async () => {
  const f = fixture();
  const events = [];
  let groupExists = false;
  let acquisitions = 0;
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
    if (!new URL(url).pathname.endsWith("/getChatMember")) {
      return await fetch(url, init);
    }
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
    acquireCredential: async () => {
      acquisitions += 1;
      return f.credential;
    },
    checkCredential: f.check,
    driveScenario: async (_args, _root, credential) => {
      assert.equal(credential, f.credential);
      credential.assertLeaseHealthy();
      assert.equal(credential.groupId, "-2042");
      assert.equal(credential.driverEnv.TELEGRAM_USER_DRIVER_CHAT_ID, "-2042");
      assert.equal(groupExists, true);
      events.push("delivered");
    },
  });
  assert.deepEqual(events, ["created", "delivered", "deleted", "released"]);
  assert.equal(acquisitions, 1);
  assert.equal(f.releaseCount(), 1);
  assert.equal(f.credential.testGroup.cleanup.status, "deleted");
});

test("a run-owned forum receives the scenario's topic sends and is deleted before release", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-owned-forum-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = fixture();
  const events = [];
  let forumExists = false;
  const forum = { ok: true, groupId: "-1002042", forumTopicId: 777 };
  const command = f.options.runCommandImpl;
  f.options.runCommandImpl = async (name, args) => {
    const reply = (value) => ({ status: 0, timedOut: false, stdout: JSON.stringify(value) });
    if (args.includes("prepare-forum")) {
      forumExists = true;
      events.push("forum-created");
      return reply({ ...forum, status: "ready" });
    }
    if (args.includes("cleanup-forum")) {
      forumExists = false;
      events.push("forum-deleted");
      return reply({ ...forum, status: "deleted" });
    }
    if (args.includes("resolve-chat")) {
      assert.equal(args[args.indexOf("--chat") + 1], forum.groupId);
      return reply({
        ok: true,
        chatId: forum.groupId,
        type: { "@type": "chatTypeSupergroup" },
        isForum: true,
      });
    }
    assert.equal(args.includes("--require-chat"), false, "the leased default group is not used");
    assert.equal(args.includes("prepare-group"), false);
    return await command(name, args);
  };
  f.options.fetchImpl = async (url) =>
    Response.json({
      ok: true,
      result: {
        getMe: { id: 42, username: "sut_bot", can_read_all_group_messages: true },
        getChat: { id: -1002042, type: "supergroup", is_forum: forumExists },
        getChatMember: { status: "member" },
      }[new URL(url).pathname.split("/").at(-1)],
    });
  const release = f.credential.release;
  f.credential.release = async () => {
    assert.equal(forumExists, false, "forum must be deleted before releasing its credential");
    events.push("released");
    await release();
  };
  const output = path.join(root, "summary.json");
  await runTelegramTestScenario({
    args: {
      createForum: true,
      output,
      scenario: { actions: [{ type: "send", atMs: 0, text: "@{sut} topic turn" }] },
    },
    acquireCredential: async () => f.credential,
    checkCredential: f.check,
    driveScenario: async (args, _root, credential) => {
      assert.equal(credential.groupId, forum.groupId);
      assert.equal(credential.chatTarget.recorderSelector, forum.groupId);
      assert.equal(args.scenario.actions[0].forumTopicId, forum.forumTopicId);
      fs.writeFileSync(output, JSON.stringify({ recordingComplete: true }));
      events.push("delivered");
    },
  });
  assert.deepEqual(events, ["forum-created", "delivered", "forum-deleted", "released"]);
  const summary = JSON.parse(fs.readFileSync(output, "utf8"));
  assert.equal(summary.recordingComplete, true);
  assert.equal(summary.testForum.setup.groupId, forum.groupId);
  assert.equal(summary.testForum.setup.forumTopicId, forum.forumTopicId);
  assert.equal(summary.testForum.cleanup.status, "deleted");
});

test("a failed run still deletes its run-owned forum before release", async () => {
  const f = fixture();
  const events = [];
  const command = f.options.runCommandImpl;
  f.options.runCommandImpl = async (name, args) => {
    if (args.includes("prepare-forum")) {
      events.push("forum-created");
      return { status: 1, timedOut: false, stderr: "topic creation failed" };
    }
    if (args.includes("cleanup-forum")) {
      events.push("forum-deleted");
      return {
        status: 0,
        timedOut: false,
        stdout: JSON.stringify({ ok: true, status: "deleted" }),
      };
    }
    return await command(name, args);
  };
  await assert.rejects(
    runTelegramTestScenario({
      args: { createForum: true, scenario: { actions: [] } },
      acquireCredential: async () => f.credential,
      checkCredential: f.check,
      driveScenario: async () => assert.fail("failed forum setup cannot start the scenario"),
    }),
    /prepare-forum failed: topic creation failed/,
  );
  assert.deepEqual(events, ["forum-created", "forum-deleted"]);
  assert.equal(f.releaseCount(), 1);
  assert.equal(f.credential.testForum.cleanup.status, "deleted");
});

test("DM reaches its SUT with an unusable group and group privacy enabled", async () => {
  const f = fixture();
  const commands = [];
  const command = f.options.runCommandImpl;
  f.options.runCommandImpl = async (name, args) => {
    commands.push(args.includes("status") ? "status" : "group-operation");
    if (!args.includes("status")) {
      throw new Error("DM must not mutate a group");
    }
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

test("explicit forum selector is resolved and preserved", async () => {
  const selector = "tg://join?invite=qa-invite";
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

test("an inaccessible explicit group stops without substituting the stored group", async () => {
  const f = fixture();
  const command = f.options.runCommandImpl;
  f.options.runCommandImpl = async (name, args) => {
    if (args.includes("prepare-group")) {
      return { status: 1, timedOut: false, stderr: "QA user cannot invite the bot" };
    }
    if (args.includes("cleanup-group")) {
      return {
        status: 0,
        timedOut: false,
        stdout: JSON.stringify({ ok: true, status: "not-created" }),
      };
    }
    if (args.includes("resolve-chat")) {
      return {
        status: 0,
        timedOut: false,
        stdout: JSON.stringify({
          ok: true,
          chatId: "-3000",
          type: { "@type": "chatTypeBasicGroup", basic_group_id: 3000 },
        }),
      };
    }
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
      if (args.includes("resolve-chat")) {
        return {
          status: 0,
          stdout: JSON.stringify({
            ok: true,
            chatId: "-10042",
            type: { "@type": "chatTypeSupergroup", supergroup_id: 42 },
          }),
        };
      }
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
      if (method === "getChat") {
        return inaccessible && !member
          ? Response.json({ ok: false, error_code: 400 }, { status: 400 })
          : Response.json({ ok: true, result: { id: -10042, type: "supergroup", is_forum: true } });
      }
      if (method === "getChatMember") {
        return Response.json({ ok: true, result: { status: member ? "member" : "left" } });
      }
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
    if (args.includes("resolve-chat")) {
      return {
        status: 0,
        timedOut: false,
        stdout: JSON.stringify({
          ok: true,
          chatId: "42",
          type: { "@type": "chatTypePrivate", user_id: 42 },
        }),
      };
    }
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
    if (args.includes("resolve-chat")) {
      return {
        status: 0,
        stdout: JSON.stringify({
          ok: true,
          chatId: "-3000",
          type: { "@type": "chatTypeBasicGroup", basic_group_id: 3000 },
          isForum: false,
        }),
      };
    }
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

test("strict membership prevents product delivery and cleans up the created group", async () => {
  const f = fixture();
  const fetch = f.options.fetchImpl;
  f.options.fetchImpl = (url) =>
    new URL(url).pathname.endsWith("/getChatMember")
      ? Promise.resolve(Response.json({ ok: true, result: { status: "restricted" } }))
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
  assert.equal(f.releaseCount(), 1);
  assert.equal(f.credential.testGroup.cleanup.status, "deleted");
});

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
          if (failure === "revocation") {
            f.revoke();
          } else {
            controller.abort(new Error("cancelled"));
          }
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
    await new Promise((resolve) => {
      signal.addEventListener("abort", resolve, { once: true });
    });
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
  assert.equal(f.releaseCount(), 1);
});

test("SIGTERM during CLI readiness settles its check before the sole lease release", async (context) => {
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
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
        fs.appendFileSync(${JSON.stringify(trace)}, 'readiness settled\\n');
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
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
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
  assert.equal(fs.readFileSync(trace, "utf8"), "readiness settled\nrelease\n");
});

test("scenario cancellation aborts a pending request in the real drive path", async (context) => {
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
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
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
  test(`${event} during readiness response consumption stops and releases`, async () => {
    const { runTelegramTestDoctor } = await import("./telegram-test-doctor.mjs");
    const f = fixture();
    const closing = Promise.withResolvers();
    const finish = Promise.withResolvers();
    const controller = new AbortController();
    f.options.fetchImpl = async (url) => {
      assert.equal(url, "https://api.telegram.org/botsynthetic-token/test/getMe");
      return {
        ok: true,
        json: async () => {
          closing.resolve();
          await finish.promise;
          return { ok: true, result: { id: 42, username: "sut_bot" } };
        },
      };
    };
    const run = runTelegramTestDoctor({
      acquireCredential: async () => f.credential,
      dm: true,
      signal: controller.signal,
      ...f.options,
    });
    await closing.promise;
    if (event === "caller cancellation") {
      controller.abort(new Error("cancelled during response"));
    } else {
      f.revoke();
    }
    finish.resolve();
    await assert.rejects(
      run,
      event === "lease loss" ? /lease revoked/u : /cancelled during response/u,
    );
    assert.equal(f.releaseCount(), 1);
    assert.equal(f.credential.testGroup, undefined);
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
    if (event === "caller cancellation") {
      controller.abort(new Error("cancelled during release"));
    } else {
      f.revoke();
    }
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
