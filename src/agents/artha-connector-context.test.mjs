import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import {
  getConnectorSource,
  withConnectorSource,
  withArthaConnectorContext,
} from "./artha-connector-context.mjs";

const key = "synthetic-key-".repeat(4);
const bearer = `x.${Buffer.from(JSON.stringify({ email: "Owner@Example.test" })).toString("base64url")}.x`;
const options = {
  auth: "oauth",
  identity: "per-requester",
  sessionKey: "agent:main:whatsapp:default:direct:+919999999999",
  requesterScope: {
    messageChannel: "whatsapp",
    agentAccountId: "default",
    requesterSenderId: "+919999999999",
  },
};
const current = {
  sessionKey: options.sessionKey,
  channel: "whatsapp",
  accountId: "default",
  senderId: "+919999999999",
  messageId: "host-message-1",
  assertCurrent() {},
};
const deps = {
  env: { PERSONAL_MCP_OPENCLAW_CONTEXT_KEY_FILE: "/host-only" },
  readKey: () => key,
  now: () => 1000000,
};

test("private host source signs the current bearer, user and exact source message", async () => {
  let received;
  const fetch = withArthaConnectorContext(
    async (r) => {
      received = r;
      return new Response();
    },
    options,
    deps,
  );
  await withConnectorSource(
    () => current,
    () => fetch("https://pitch.artha.vc/mcp", { headers: { Authorization: `Bearer ${bearer}` } }),
  );
  const [payload, signature] = received.headers.get("x-artha-connector-context").split(".");
  assert.equal(received.redirect, "error");
  assert.equal(signature, createHmac("sha256", key).update(payload).digest("hex"));
  assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url")), {
    v: 1,
    aud: "artha-personal-mcp",
    identity_mode: "per-requester",
    session_kind: "interactive",
    user_id: "owner@example.test",
    channel: "whatsapp",
    chat_kind: "private",
    conversation_id: options.sessionKey,
    message_id: current.messageId,
    request_id: JSON.parse(Buffer.from(payload, "base64url")).request_id,
    token_sha256: createHash("sha256").update(bearer).digest("hex"),
    iat: 1000,
    exp: 1090,
  });
});

test("group, subagent, missing source and another origin never carry forged context", async () => {
  for (const sessionKey of [
    "agent:main:whatsapp:group:123@g.us",
    "agent:main:subagent:abc",
    options.sessionKey,
  ]) {
    const fetch = withArthaConnectorContext(
      async (r) => {
        assert.equal(r.headers.has("x-artha-connector-context"), false);
        return new Response();
      },
      { ...options, sessionKey },
      deps,
    );
    await fetch("https://pitch.artha.vc/mcp", {
      headers: { Authorization: `Bearer ${bearer}`, "x-artha-connector-context": "forged" },
    });
    await withConnectorSource(
      () => current,
      () =>
        fetch("https://other.example/mcp", {
          headers: { Authorization: `Bearer ${bearer}`, "x-artha-connector-context": "forged" },
        }),
    );
  }
});

test("retired source cannot sign detached work and live source revocation stops I/O", async () => {
  let release;
  let detached;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await withConnectorSource(
    () => current,
    async () => {
      detached = (async () => {
        await gate;
        return getConnectorSource();
      })();
    },
  );
  release();
  assert.equal(await detached, undefined);
  let io = 0;
  const fetch = withArthaConnectorContext(
    async () => {
      io++;
      return new Response();
    },
    options,
    deps,
  );
  await assert.rejects(
    withConnectorSource(
      () => ({
        ...current,
        assertCurrent() {
          throw new Error("revoked");
        },
      }),
      () => fetch("https://pitch.artha.vc/mcp", { headers: { Authorization: `Bearer ${bearer}` } }),
    ),
    /revoked/,
  );
  assert.equal(io, 0);
});

test("owner's scheduled job in its DM signs as scheduled; other sessions and requesters do not", async () => {
  const scheduled = {
    scheduled: true,
    sessionKey: options.sessionKey,
    messageId: "cron:job-1:run-1",
    assertCurrent() {},
  };
  const signed = async (fetchOptions, source = scheduled) => {
    let received;
    const fetch = withArthaConnectorContext(
      async (r) => {
        received = r;
        return new Response();
      },
      fetchOptions,
      deps,
    );
    await withConnectorSource(
      () => source,
      () => fetch("https://pitch.artha.vc/mcp", { headers: { Authorization: `Bearer ${bearer}` } }),
    );
    return received.headers.get("x-artha-connector-context");
  };
  const header = await signed(options);
  const claims = JSON.parse(Buffer.from(header.split(".")[0], "base64url"));
  assert.equal(claims.session_kind, "scheduled");
  assert.equal(claims.message_id, "cron:job-1:run-1");
  assert.equal(claims.conversation_id, options.sessionKey);
  assert.equal(await signed({ ...options, sessionKey: "agent:main:cron:job-1" }), null);
  assert.equal(
    await signed({
      ...options,
      requesterScope: { ...options.requesterScope, requesterSenderId: "+911" },
    }),
    null,
  );
  assert.equal(await signed(options, { ...scheduled, sessionKey: "agent:main:cron:job-1" }), null);
});
