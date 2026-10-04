import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCapsule,
  createRpc,
  end,
  prepare,
  ring,
  selectNode,
  status,
} from "./incoming-call.mjs";

const CALL = "12345678-1234-4234-8234-123456789abc";
const NOW = 1800000000000;
const NODE = {
  nodeId: "android-test",
  platform: "android",
  paired: true,
  connected: true,
  commands: ["talk.incoming", "talk.callStatus", "talk.endCall"],
};

function harness(options = {}) {
  const calls = [];
  const messages = [];
  let state = "unknown";
  let key;
  let injectCount = 0;
  let ringCount = 0;
  const rpc = (method, params) => {
    calls.push({ method, params });
    if (method === "node.list") {
      return { nodes: options.nodes ?? [NODE] };
    }
    if (method === "sessions.create") {
      key = params.key;
      return { ok: true, key, runStarted: false };
    }
    if (method === "chat.history") {
      return {
        messages: messages.map((text) => ({
          role: "assistant",
          content: [{ type: "text", text }],
        })),
      };
    }
    if (method === "chat.inject") {
      injectCount++;
      if (options.injectFailsBefore) {
        throw new Error("synthetic timeout");
      }
      messages.push(params.message);
      if (options.injectFailsAfter) {
        throw new Error("synthetic timeout");
      }
      return { ok: true, messageId: `msg-${injectCount}` };
    }
    assert.equal(method, "node.invoke");
    if (params.command === "talk.incoming") {
      ringCount++;
      if (options.ringFailsBefore) {
        throw new Error("synthetic timeout");
      }
      state = "ringing";
      if (options.ringFailsAfter) {
        throw new Error("synthetic timeout");
      }
    } else if (params.command === "talk.endCall") {
      state = "ended";
      if (options.endFailsAfter) {
        throw new Error("synthetic timeout");
      }
    } else {
      assert.equal(params.command, "talk.callStatus");
    }
    return {
      ok: true,
      nodeId: params.nodeId,
      command: params.command,
      payload: { callId: CALL, sessionKey: key, status: state },
    };
  };
  return {
    rpc,
    calls,
    messages,
    get injectCount() {
      return injectCount;
    },
    get ringCount() {
      return ringCount;
    },
  };
}

function prepared(h) {
  return prepare(
    h.rpc,
    {
      agentId: "talk-assistant",
      gatewayUrl: "wss://gateway.example:18789",
      topic: "Synthetic comparison",
      briefing:
        "Conclusion: option A. Uncertainty: pending quote. Source: example.org/report. Decision: pick a date.",
    },
    { now: () => NOW, uuid: () => CALL },
  );
}

test("prepare, ring, status and end use exact owner RPCs without launching a model turn", async () => {
  const h = harness();
  const receipt = await prepared(h);
  assert.equal(h.ringCount, 0);
  assert.equal((await ring(h.rpc, receipt, { now: () => NOW + 1000 })).status, "ringing");
  assert.equal((await status(h.rpc, receipt)).status, "ringing");
  assert.equal((await end(h.rpc, receipt)).status, "ended");
  const create = h.calls.find((call) => call.method === "sessions.create").params;
  assert.equal(create.message, undefined);
  assert.equal(create.task, undefined);
  assert.equal(create.key, receipt.sessionKey);
  assert.equal(create.fastMode, true);
  assert.equal(create.thinkingLevel, "medium");
  const incoming = h.calls.find((call) => call.params.command === "talk.incoming").params;
  assert.equal(incoming.idempotencyKey, `incoming-call:${CALL}:ring`);
  assert.equal(incoming.params.expiresAtMs, NOW + 180000);
});

test("replays do not ring again, including terminal calls", async () => {
  const h = harness();
  const receipt = await prepared(h);
  await ring(h.rpc, receipt, { now: () => NOW });
  assert.equal((await ring(h.rpc, receipt, { now: () => NOW })).replay, true);
  await end(h.rpc, receipt);
  assert.equal((await ring(h.rpc, receipt, { now: () => NOW })).status, "ended");
  assert.equal(h.ringCount, 1);
});

test("fail closed for offline, missing capability, or ambiguous nodes before session mutation", async () => {
  for (const nodes of [
    [{ ...NODE, connected: false }],
    [{ ...NODE, commands: ["talk.incoming"] }],
    [NODE, { ...NODE, nodeId: "other" }],
  ]) {
    const h = harness({ nodes });
    await assert.rejects(() => prepared(h), /online paired/);
    assert.equal(
      h.calls.some((call) => call.method === "sessions.create"),
      false,
    );
  }
  assert.equal(
    await selectNode(harness({ nodes: [NODE, { ...NODE, nodeId: "other" }] }).rpc, "android-test"),
    "android-test",
  );
});

test("expired invitation never dispatches incoming", async () => {
  const h = harness();
  const receipt = await prepared(h);
  await assert.rejects(() => ring(h.rpc, receipt, { now: () => NOW + 180000 }), /expired/);
  assert.equal(h.ringCount, 0);
});

test("capsule tampering or conversation activity prevents ringing", async () => {
  const h = harness();
  const receipt = await prepared(h);
  h.messages.push("Unrelated new context");
  await assert.rejects(() => ring(h.rpc, receipt, { now: () => NOW }), /readback mismatch/);
  assert.equal(h.ringCount, 0);
});

test("injection timeout after commit is reconciled without duplicate append", async () => {
  const h = harness({ injectFailsAfter: true });
  const receipt = await prepared(h);
  assert.equal(h.injectCount, receipt.messageCount);
  assert.equal(h.messages.length, receipt.messageCount);
});

test("injection timeout without proof never retries or rings", async () => {
  const h = harness({ injectFailsBefore: true });
  await assert.rejects(() => prepared(h), /unconfirmed/);
  assert.equal(h.injectCount, 1);
  assert.equal(h.ringCount, 0);
});

test("ring and end timeouts after commit reconcile against Android authority", async () => {
  const h = harness({ ringFailsAfter: true, endFailsAfter: true });
  const receipt = await prepared(h);
  assert.equal((await ring(h.rpc, receipt, { now: () => NOW })).reconciled, true);
  assert.equal((await end(h.rpc, receipt)).reconciled, true);
  assert.equal(h.ringCount, 1);
});

test("unproven ring timeout is visible and does not retry", async () => {
  const h = harness({ ringFailsBefore: true });
  await assert.rejects(
    async () => ring(h.rpc, await prepared(h), { now: () => NOW }),
    /outcome is unknown/,
  );
  assert.equal(h.ringCount, 1);
});

test("receipt cannot redirect a call into another agent/session", async () => {
  const h = harness();
  const receipt = await prepared(h);
  receipt.sessionKey = `agent:other:incoming-call:${CALL}`;
  await assert.rejects(() => ring(h.rpc, receipt, { now: () => NOW }), /must match/);
  assert.equal(h.ringCount, 0);
});

test("receipt pins a credential-free Gateway identity and rejects missing or unsafe URLs", async () => {
  const h = harness();
  const receipt = await prepared(h);
  assert.equal(receipt.gatewayUrl, "wss://gateway.example:18789");
  for (const gatewayUrl of [undefined, "wss://user:SECRET@example.org", "not-a-url"]) {
    await assert.rejects(
      () => status(h.rpc, { ...receipt, gatewayUrl }),
      (error) => !error.message.includes("SECRET") && error.message.includes("Gateway URL"),
    );
  }
});

test("capsule respects complete unicode, per-item and escaped JSON budgets", () => {
  const input = { callId: CALL, topic: "Test", briefing: "Facts. ".repeat(500) };
  const messages = buildCapsule(input);
  assert.ok(messages.length > 1 && messages.length <= 12);
  assert.ok(messages.every((message) => message.length < 800));
  assert.throws(
    () => buildCapsule({ ...input, briefing: "😀".repeat(3000) }),
    /safety budget|too long/,
  );
  assert.throws(() => buildCapsule({ ...input, briefing: "<".repeat(2000) }), /safety budget/);
  assert.ok(
    buildCapsule({ ...input, briefing: "😀".repeat(400) }).every(
      (message) => !/\p{Surrogate}/u.test(message),
    ),
  );
});

test("SDK transport pins without redirecting, requires existing grants, and suppresses raw errors", async () => {
  let captured;
  const expectUrl = "wss://gateway.example:18789";
  const rpc = createRpc({
    expectUrl,
    loadSdk: async () => ({
      callGatewayFromCli: async (...args) => {
        captured = args;
        return { ok: true };
      },
    }),
  });
  const params = { message: "$(touch /never) `not-a-command`\nline two" };
  await rpc("chat.inject", params);
  assert.deepEqual(captured, [
    "chat.inject",
    { expectUrl, json: true, timeout: "30000" },
    params,
    {
      useStoredDeviceAuth: true,
      requiredStoredDeviceAuthScopes: ["operator.admin"],
      sharedStateMode: "read-only",
      progress: false,
    },
  ]);
  await assert.rejects(() => rpc("chat.send", {}), /Unsupported/);
  const failed = createRpc({
    expectUrl,
    loadSdk: async () => ({
      callGatewayFromCli: async () => {
        throw new Error("SECRET");
      },
    }),
  });
  await assert.rejects(
    () => failed("node.invoke", {}),
    (error) => !error.message.includes("SECRET") && error.message.includes("uncertain"),
  );
  const unavailable = createRpc({
    expectUrl,
    loadSdk: async () => {
      throw new Error("SECRET");
    },
  });
  await assert.rejects(
    () => unavailable("node.list", {}),
    (error) => !error.message.includes("SECRET") && error.message.includes("installed OpenClaw"),
  );
  assert.throws(
    () => createRpc({ expectUrl: "wss://user:secret@example.org" }),
    /without credentials/,
  );
  assert.throws(() => createRpc(), /Gateway URL/);
});
