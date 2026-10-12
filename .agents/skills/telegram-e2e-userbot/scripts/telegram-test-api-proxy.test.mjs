import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { startTelegramTestApiProxy, telegramTestApiPath } from "./telegram-test-api-proxy.mjs";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

test("inserts the Test Server segment after the bot token", () => {
  assert.equal(telegramTestApiPath("/bot123:ABC/getUpdates"), "/bot123:ABC/test/getUpdates");
  assert.equal(
    telegramTestApiPath("/file/bot123:ABC/photos/file.jpg"),
    "/file/bot123:ABC/test/photos/file.jpg",
  );
  assert.throws(() => telegramTestApiPath("/healthz"), /invalid Bot API path/u);
});

test("proxies method, query, headers, and body to the Test Server path", async (t) => {
  let observed;
  const upstreamServer = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      observed = {
        method: request.method,
        url: request.url,
        body,
        marker: request.headers["x-marker"],
      };
      response.writeHead(201, { "content-type": "application/json", "x-upstream": "yes" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  const upstream = await listen(upstreamServer);
  const previousDispatcher = getGlobalDispatcher();
  const dispatcher = new Agent({ allowH2: false });
  setGlobalDispatcher(dispatcher);
  const proxy = await startTelegramTestApiProxy({ upstream });
  t.after(async () => {
    await proxy.close();
    setGlobalDispatcher(previousDispatcher);
    await dispatcher.close();
    await new Promise((resolve) => upstreamServer.close(resolve));
  });
  const response = await fetch(`${proxy.apiRoot}/bot123:ABC/sendMessage?chat_id=42`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-marker": "kept" },
    body: JSON.stringify({ text: "hello 🌻" }),
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("x-upstream"), "yes");
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(observed, {
    method: "POST",
    url: "/bot123:ABC/test/sendMessage?chat_id=42",
    body: '{"text":"hello 🌻"}',
    marker: "kept",
  });
});

test("drains every pending Test Server update", async (t) => {
  const offsets = [];
  const upstreamServer = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      offsets.push(JSON.parse(body).offset);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ ok: true, result: offsets.length === 1 ? [{ update_id: 7 }] : [] }),
      );
    });
  });
  const upstream = await listen(upstreamServer);
  const proxy = await startTelegramTestApiProxy({ upstream });
  t.after(async () => {
    await proxy.close();
    await new Promise((resolve) => upstreamServer.close(resolve));
  });

  await proxy.drainUpdates("123:ABC");

  assert.deepEqual(offsets, [0, 8]);
  const rows = proxy.getRequestLog();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].method, "getUpdates");
  assert.equal(rows[0].updates, 1);
  assert.equal(rows[0].status, 200);
  assert.ok(rows[0].doneAt >= rows[0].at);
});

test("logs only nonempty getUpdates counts and preserves response bytes", async (t) => {
  let payload;
  const proxy = await startTelegramTestApiProxy({
    fetchImpl: async () =>
      new Response(payload, { headers: { "content-type": "application/json" } }),
  });
  t.after(() => proxy.close());
  const bodies = [
    '{ "ok": true, "result": [{"update_id":123,"message":{"text":"private text","chat":{"id":4242}}},{"update_id":124}] }\n',
    '{"ok":true,"result":[]}',
    '{"ok":false,"description":"synthetic error"}',
    '{"ok":true,"result":null}',
    "not-json",
  ];
  for (const body of bodies) {
    payload = body;
    const response = await fetch(`${proxy.apiRoot}/bot123:ABC/getUpdates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"offset":123,"timeout":0}',
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), body);
  }
  const rows = proxy.getRequestLog();
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).toSorted(), [
    "at",
    "doneAt",
    "method",
    "status",
    "updates",
  ]);
  assert.equal(rows[0].method, "getUpdates");
  assert.equal(rows[0].updates, 2);
  assert.equal(rows[0].status, 200);
  assert.ok(rows[0].doneAt >= rows[0].at);
});

test("holds one upstream-accepted method response until explicit release", async (t) => {
  const upstreamServer = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  const upstream = await listen(upstreamServer);
  const proxy = await startTelegramTestApiProxy({ upstream });
  t.after(async () => {
    await proxy.close();
    await new Promise((resolve) => upstreamServer.close(resolve));
  });
  proxy.holdNextResponse({ method: "sendMessage", skip: 1 });
  await fetch(`${proxy.apiRoot}/bot123:ABC/sendMessage`, { method: "POST", body: "first" });
  let bodySettled = false;
  const heldBody = fetch(`${proxy.apiRoot}/bot123:ABC/sendMessage`, {
    method: "POST",
    body: "second",
  })
    .then((response) => response.json())
    .then((body) => {
      bodySettled = true;
      return body;
    });
  const held = await proxy.waitForHeldResponse("sendMessage", 1_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bodySettled, false);
  assert.deepEqual(
    { method: held.method, ordinal: held.ordinal },
    { method: "sendMessage", ordinal: 2 },
  );
  assert.equal(proxy.getRequestLog().at(-1).doneAt, undefined);
  proxy.releaseHeldResponse();
  assert.deepEqual(await heldBody, { ok: true });
  assert.equal(proxy.getResponseHoldEvents()[0].releasedAt >= held.heldAt, true);
  assert.ok(proxy.getRequestLog().at(-1).doneAt >= held.heldAt);
});

test("rejects only the selected matching request before forwarding and then resumes", async (t) => {
  const forwarded = [];
  const proxy = await startTelegramTestApiProxy({
    fetchImpl: async (_url, init) => {
      forwarded.push(JSON.parse(await new Response(init.body).text()).text);
      return new Response('{"ok":true}', {
        headers: { "content-type": "application/json" },
      });
    },
  });
  t.after(() => proxy.close());
  proxy.rejectNextRequest({ method: "sendMessage", bodyIncludes: "FINAL", skip: 1 });
  for (const [method, text, expectedStatus] of [
    ["editMessageText", "FINAL from another method", 200],
    ["sendMessage", "preview", 200],
    ["sendMessage", "FINAL first match", 200],
    ["sendMessage", "FINAL rejected", 400],
    ["sendMessage", "FINAL next request", 200],
  ]) {
    const response = await fetch(`${proxy.apiRoot}/bot123:ABC/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    assert.equal(response.status, expectedStatus);
    assert.equal((await response.json()).ok, expectedStatus === 200);
  }
  assert.deepEqual(forwarded, [
    "FINAL from another method",
    "preview",
    "FINAL first match",
    "FINAL next request",
  ]);
  assert.deepEqual(
    proxy.getRequestRejectionEvents().map(({ method, upstreamForwarded }) => ({
      method,
      upstreamForwarded,
    })),
    [{ method: "sendMessage", upstreamForwarded: false }],
  );
});

test("injects repeated flood waits with retry_after before forwarding", async (t) => {
  // Chat ID digits may also appear in legitimate timing fields.
  t.mock.method(Date, "now", () => 1790301001001);
  const forwarded = [];
  const proxy = await startTelegramTestApiProxy({
    fetchImpl: async (_url, init) => {
      forwarded.push(JSON.parse(await new Response(init.body).text()).text);
      return new Response('{"ok":true}', { headers: { "content-type": "application/json" } });
    },
  });
  t.after(() => proxy.close());
  proxy.rejectNextRequest({
    method: "sendMessage",
    bodyIncludes: "FINAL",
    times: 2,
    retryAfter: 3,
  });
  const statuses = [];
  for (const text of ["preview", "FINAL", "FINAL", "FINAL"]) {
    const response = await fetch(`${proxy.apiRoot}/bot123:ABC/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const body = await response.json();
    statuses.push([response.status, body.parameters?.retry_after]);
  }
  assert.deepEqual(statuses, [
    [200, undefined],
    [429, 3],
    [429, 3],
    [200, undefined],
  ]);
  assert.deepEqual(forwarded, ["preview", "FINAL"]);
  proxy.rejectNextRequest({ method: "sendMessage", retryAfter: 0 });
  const bare = await fetch(`${proxy.apiRoot}/bot123:ABC/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "bare" }),
  });
  const bareBody = await bare.json();
  assert.equal(bare.status, 429);
  assert.equal(bareBody.parameters, undefined);
  assert.deepEqual(
    proxy.getRequestLog().map(({ method }) => method),
    Array(5).fill("sendMessage"),
  );
  await fetch(`${proxy.apiRoot}/bot123:ABC/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: -1001, text: "group" }),
  });
  assert.equal(proxy.getRequestLog().at(-1).chat, "group");
  for (const event of proxy.getRequestLog()) {
    assert.equal(typeof event.at, "number");
    assert.ok(event.doneAt >= event.at);
    assert.deepEqual(
      Object.keys(event).toSorted(),
      event.chat === undefined
        ? ["at", "doneAt", "method", "status"]
        : ["at", "chat", "doneAt", "method", "status"],
    );
  }
  assert.deepEqual(
    proxy.getRequestRejectionEvents().map(({ errorCode, retryAfter }) => [errorCode, retryAfter]),
    [
      [429, 3],
      [429, 3],
      [429, 0],
    ],
  );
});

test("forwards file downloads before, during, and after a one-shot rejection", async (t) => {
  const upstreamPaths = [];
  const proxy = await startTelegramTestApiProxy({
    fetchImpl: async (url) => {
      upstreamPaths.push(new URL(url).pathname);
      return new Response("synthetic-file-bytes", { status: 200 });
    },
  });
  t.after(() => proxy.close());
  const filePath = "/file/bot123:ABC/photos/current.jpg";
  const download = async () => {
    const response = await fetch(`${proxy.apiRoot}${filePath}`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "synthetic-file-bytes");
  };

  await download();
  proxy.rejectNextRequest({ method: "sendMessage" });
  await download();
  const rejected = await fetch(`${proxy.apiRoot}/bot123:ABC/sendMessage`, {
    method: "POST",
    body: "{}",
  });
  assert.equal(rejected.status, 400);
  await download();
  assert.deepEqual(upstreamPaths, Array(3).fill("/file/bot123:ABC/test/photos/current.jpg"));
  assert.equal(proxy.getRequestRejectionEvents().length, 1);
  assert.deepEqual(
    proxy.getRequestLog().map(({ method }) => method),
    ["file", "file", "sendMessage", "file"],
  );
  for (const event of proxy.getRequestLog()) {
    assert.deepEqual(Object.keys(event).toSorted(), ["at", "doneAt", "method", "status"]);
    assert.ok(event.doneAt >= event.at);
  }
});

test("file timing rows never match response holds or request rejections", async (t) => {
  const proxy = await startTelegramTestApiProxy({
    fetchImpl: async () => new Response("synthetic-file-bytes"),
  });
  t.after(() => proxy.close());
  proxy.holdNextResponse({ method: "file" });
  const heldControl = await fetch(`${proxy.apiRoot}/file/bot123:ABC/photos/current.jpg`);
  assert.deepEqual(proxy.getResponseHoldEvents(), []);
  assert.equal(await heldControl.text(), "synthetic-file-bytes");
  proxy.rejectNextRequest({ method: "file" });
  const rejectedControl = await fetch(`${proxy.apiRoot}/file/bot123:ABC/photos/current.jpg`);
  assert.equal(rejectedControl.status, 200);
  assert.equal(await rejectedControl.text(), "synthetic-file-bytes");
  assert.deepEqual(proxy.getRequestRejectionEvents(), []);
});

test("getFile timing ends when the streamed response finishes", async (t) => {
  let now = 100;
  t.mock.method(Date, "now", () => now);
  let stream;
  const proxy = await startTelegramTestApiProxy({
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            stream = controller;
            controller.enqueue(new TextEncoder().encode("first"));
          },
        }),
      ),
  });
  t.after(() => proxy.close());
  const response = await fetch(`${proxy.apiRoot}/bot123:ABC/getFile`);
  assert.deepEqual(proxy.getRequestLog(), [{ method: "getFile", at: 100, status: 200 }]);
  now = 200;
  stream.close();
  assert.equal(await response.text(), "first");
  assert.deepEqual(proxy.getRequestLog(), [
    { method: "getFile", at: 100, status: 200, doneAt: 200 },
  ]);
});

test("records completion timing on upstream and response-stream errors", async (t) => {
  t.mock.method(console, "error", () => {});
  for (const [expectedStatus, fetchImpl] of [
    [
      502,
      async () => {
        throw new Error("synthetic upstream failure");
      },
    ],
    [
      200,
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("synthetic stream failure"));
            },
          }),
        ),
    ],
  ]) {
    const proxy = await startTelegramTestApiProxy({ fetchImpl });
    t.after(() => proxy.close());
    const response = await fetch(`${proxy.apiRoot}/bot123:ABC/getFile`);
    assert.equal(response.status, expectedStatus);
    assert.equal((await response.json()).ok, false);
    const [event] = proxy.getRequestLog();
    assert.ok(event.doneAt >= event.at);
  }
});

test("reports upstream failures without exposing exception details or bot tokens", async (t) => {
  const privateDetail = "synthetic-private-upstream-detail";
  const cause = Object.assign(new Error(privateDetail), { code: "ECONNRESET" });
  const diagnostic = t.mock.method(console, "error", () => {});
  const proxy = await startTelegramTestApiProxy({
    fetchImpl: async () => {
      throw new TypeError(privateDetail, { cause });
    },
  });
  t.after(() => proxy.close());

  const response = await fetch(`${proxy.apiRoot}/bot123:ABC/deleteWebhook`, {
    method: "POST",
    body: "{}",
  });

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    ok: false,
    description: "Telegram Test Server proxy failed.",
  });
  assert.equal(diagnostic.mock.calls.length, 1);
  const line = diagnostic.mock.calls[0]?.arguments[0];
  assert.equal(typeof line, "string");
  assert.deepEqual(JSON.parse(line), {
    event: "telegram_test_api_proxy_failure",
    phase: "upstream-fetch",
    method: "deleteWebhook",
    errorClass: "TypeError",
    errorCode: "ECONNRESET",
  });
  assert.doesNotMatch(line, /123:ABC|synthetic-private/u);
});

test("getUpdates preserves the caller offset after upstream failure and closes without failure noise", async (t) => {
  const diagnostic = t.mock.method(console, "error", () => {});
  const offsets = [];
  const cause = Object.assign(new Error("synthetic-private /bot123:ABC"), { code: "ECONNRESET" });
  let upstreamStarted;
  let upstreamAborted = false;
  const started = new Promise((resolve) => {
    upstreamStarted = resolve;
  });
  const proxy = await startTelegramTestApiProxy({
    fetchImpl: async (_url, init) => {
      offsets.push(JSON.parse(await new Response(init.body).text()).offset);
      if (offsets.length === 1) {
        throw new TypeError("synthetic-private upstream failure", { cause });
      }
      if (offsets.length === 2) {
        return new Response('{"ok":true,"result":[{"update_id":123}]}', {
          headers: { "content-type": "application/json" },
        });
      }
      upstreamStarted();
      return await new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => {
            upstreamAborted = true;
            reject(init.signal.reason);
          },
          { once: true },
        );
      });
    },
  });
  t.after(() => proxy.close());
  const poll = (offset) =>
    fetch(`${proxy.apiRoot}/bot123:ABC/getUpdates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offset, timeout: 30 }),
    });
  const failed = await poll(123);
  assert.equal(failed.status, 502);
  assert.deepEqual(await failed.json(), {
    ok: false,
    description: "Telegram Test Server proxy failed.",
  });
  const recovered = await poll(123);
  assert.equal(recovered.status, 200);
  assert.deepEqual(await recovered.json(), { ok: true, result: [{ update_id: 123 }] });
  const request = poll(124).catch(() => undefined);
  await started;
  await proxy.close();
  await request;
  assert.deepEqual(offsets, [123, 123, 124]);
  assert.equal(upstreamAborted, true);
  assert.equal(diagnostic.mock.calls.length, 1);
  const line = diagnostic.mock.calls[0].arguments[0];
  assert.deepEqual(JSON.parse(line), {
    event: "telegram_test_api_proxy_failure",
    phase: "upstream-fetch",
    method: "getUpdates",
    errorClass: "TypeError",
    errorCode: "ECONNRESET",
  });
  assert.doesNotMatch(line, /123:ABC|synthetic-private/u);
});

test("lease revocation blocks every later Bot API request", async (t) => {
  t.mock.method(console, "error", () => {});
  const leaseError = new Error("lease revoked");
  let healthy = true;
  let revoke;
  let upstreamRequests = 0;
  const whenUnhealthy = new Promise((resolve) => {
    revoke = () => {
      healthy = false;
      resolve(leaseError);
    };
  });
  const proxy = await startTelegramTestApiProxy({
    leaseHealth: {
      assertHealthy: () => {
        if (!healthy) throw leaseError;
      },
      whenUnhealthy,
    },
    fetchImpl: async () => {
      upstreamRequests += 1;
      return new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  t.after(() => proxy.close());
  // Revocation destroys existing sockets; the later request needs a fresh connection.
  const before = await fetch(`${proxy.apiRoot}/bot123:ABC/getMe`, {
    headers: { connection: "close" },
  });
  assert.equal(before.status, 200);
  assert.deepEqual(await before.json(), { ok: true });
  revoke();
  await new Promise((resolve) => setImmediate(resolve));
  const after = await fetch(`${proxy.apiRoot}/bot123:ABC/sendMessage`, {
    method: "POST",
    body: "{}",
  });
  assert.equal(after.status, 502);
  assert.equal(upstreamRequests, 1);
});
