import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { test } from "node:test";
import { createHandler, googleVerifier } from "./server.mjs";
import { approvalCard, handleChat, parseRequest, settleDecision } from "./service.mjs";

const now = Date.parse("2026-11-16T12:00:00Z");
const payload = {
  requestId: "a83b87dc-4738-471e-aaf4-b59d89d35523",
  action: "Approve skipping release validation",
  expiresAt: "2026-11-16T13:00:00Z",
  repository: "example/project",
  candidate: "a".repeat(40),
  artifacts: [{ digest: "sha256:" + "b".repeat(64) }],
};
const request = () => parseRequest({ payload: JSON.stringify(payload) }, now);
const enrollment = { userId: "users/1234", space: "spaces/DM123" };
const actor = () => ({
  ...enrollment,
  email: "dallin@openclaw.org",
  requestId: payload.requestId,
  digest: request().digest,
  decision: "approved",
  now,
});
const event = () => ({
  chat: {
    user: { name: enrollment.userId, type: "HUMAN", email: "dallin@openclaw.org" },
    buttonClickedPayload: { space: { name: enrollment.space } },
  },
  commonEventObject: {
    parameters: { requestId: payload.requestId, digest: request().digest, decision: "approve" },
  },
});

await test("immutable request parser rejects ambiguous JSON, missing identity, and expiry outside window", () => {
  for (const value of [
    {},
    { payload: "{}" },
    { payload: JSON.stringify({ ...payload, expiresAt: "invalid" }) },
    { payload: JSON.stringify({ ...payload, expiresAt: "2026-11-18T13:00:00Z" }) },
    {
      payload: JSON.stringify(payload).replace(
        '"example/project"',
        '"wrong","repository":"example/project"',
      ),
    },
  ]) {
    assert.throws(() => parseRequest(value, now));
  }
  assert.throws(() => parseRequest({ payload: JSON.stringify(payload) }, now + 3600000));
  assert.notEqual(
    request().digest,
    parseRequest({ payload: JSON.stringify({ ...payload, candidate: "c".repeat(40) }) }, now)
      .digest,
  );
});

await test("settles exact enrolled request once, refuses expiry, content and identity mismatches", () => {
  const approved = settleDecision(request(), actor(), enrollment);
  assert.equal(approved.state, "approved");
  assert.equal(approved.approver, "users/1234");
  assert.equal(approved.decidedAt, "2026-11-16T12:00:00.000Z");
  assert.equal(
    settleDecision(approved, { ...actor(), decision: "rejected" }, enrollment),
    approved,
  );
  const rejected = settleDecision(request(), { ...actor(), decision: "rejected" }, enrollment);
  assert.equal(settleDecision(rejected, actor(), enrollment).state, "rejected");
  for (const changes of [
    { digest: "sha256:" + "0".repeat(64) },
    { userId: "users/999" },
    { space: "spaces/OTHER" },
    { now: now + 3600000 },
  ]) {
    assert.throws(() => settleDecision(request(), { ...actor(), ...changes }, enrollment));
  }
});

await test("Google Chat callback admits only designated human button events, not ordinary approval text", async () => {
  let decision;
  const store = {
    decide: async (value) => {
      decision = value;
      return { ...request(), state: "approved", lastAttempt: { previousState: "pending" } };
    },
  };
  assert.match((await handleChat(event(), store, now)).text, /approved/u);
  assert.equal(decision.userId, "users/1234");
  for (const email of ["services@openclaw.org", "someone@openclaw.org"]) {
    const value = event();
    value.chat.user.email = email;
    await assert.rejects(handleChat(value, store, now), /not an approver/u);
  }
  const bot = event();
  bot.chat.user.type = "BOT";
  await assert.rejects(handleChat(bot, store, now), /human identity/u);
  const message = event();
  delete message.chat.buttonClickedPayload;
  message.chat.messagePayload = { message: { text: "Approve" } };
  await assert.rejects(handleChat(message, store, now), /Only approval-card/u);
});

await test("card contains complete escaped immutable contents and identity-bound buttons", () => {
  const card = approvalCard(request(), "https://approval.example/chat");
  const widgets = card.cardsV2[0].card.sections.flatMap((section) => section.widgets);
  const buttons = widgets.at(-1).buttonList.buttons;
  assert.equal(buttons[0].onClick.action.function, "https://approval.example/chat");
  assert.equal(
    buttons[0].onClick.action.parameters.find((item) => item.key === "digest").value,
    request().digest,
  );
  assert.match(JSON.stringify(card), /example\/project/u);
  assert.doesNotMatch(JSON.stringify(card), /<pre>/u);
  assert.ok(card.cardsV2[0].card.sections.some((section) => section.header === "Artifacts"));
  assert.ok(widgets.some((widget) => widget.decoratedText?.topLabel === "Repository"));
  assert.ok(card.cardsV2[0].card.sections.some((section) => section.collapsible));
  const partial = parseRequest(
    {
      payload: JSON.stringify({
        ...payload,
        action: "Approve publication with incomplete validation",
        validationSnapshot: {
          runId: "456",
          summary: { passed: 47, failed: 1, unfinished: 1 },
          outstandingChecks: [
            {
              name: "Windows startup",
              status: "failed",
              jobId: "501",
              runId: "457",
              runAttempt: "1",
            },
          ],
        },
        evidenceUrl: "https://github.com/example/project/actions/runs/456",
        unsafeUrl: "javascript:alert(1)",
      }),
    },
    now,
  );
  const sections = approvalCard(partial, "https://approval.example/chat").cardsV2[0].card.sections;
  const validation = sections.find((section) => section.header === "Existing validation");
  assert.match(validation.widgets[0].decoratedText.text, /47 passed · 1 failed · 1 unfinished/u);
  assert.match(validation.widgets[1].textParagraph.text, /Windows startup.*FAILED/u);
  assert.equal(validation.uncollapsibleWidgetsCount, 2);
  const links = sections
    .flatMap((section) => section.widgets)
    .filter((widget) => widget.decoratedText?.onClick);
  assert.equal(links.length, 1);
  assert.equal(
    links[0].decoratedText.onClick.openLink.url,
    "https://github.com/example/project/actions/runs/456",
  );

  const html = parseRequest(
    { payload: JSON.stringify({ ...payload, note: "<a>hidden</a>" }) },
    now,
  );
  assert.match(
    JSON.stringify(approvalCard(html, "https://approval.example/chat")),
    /&lt;a&gt;hidden&lt;\/a&gt;/u,
  );
});

await test("cards preserve the full approval action and lossless fractional values", () => {
  const precise = parseRequest(
    {
      payload: JSON.stringify({
        ...payload,
        smallAmount: 0.0004,
        budget: { values: { amount: 12.34567, fee: 0.0004 } },
      }),
    },
    now,
  );
  const sections = approvalCard(precise, "https://approval.example/chat").cardsV2[0].card.sections;
  const fields = sections
    .flatMap((section) => section.widgets)
    .map((widget) => widget.decoratedText)
    .filter(Boolean);
  assert.deepEqual(
    {
      action: fields.find((field) => field.topLabel === "Action")?.text,
      wraps: fields.find((field) => field.topLabel === "Action")?.wrapText,
      amount: fields.find((field) => field.topLabel === "Small Amount")?.text,
      budget: fields.find((field) => field.topLabel === "Values")?.text,
    },
    {
      action: payload.action,
      wraps: true,
      amount: "0.0004",
      budget: "12.34567 amount · 0.0004 fee",
    },
  );
});

await test("HTTP boundary enforces separate principals; request-only token cannot hit callback", async (t) => {
  let created;
  const handler = createHandler({
    baseUrl: "https://approval.example",
    chatIdentity: "chat-principal",
    requesters: ["machine"],
    readers: ["publisher"],
    verify: async (token, _audience, allowed) => {
      if (!allowed.includes(token?.slice(7))) {
        throw new Error("Unauthorized");
      }
    },
    store: {
      enrollments: async () => [
        { email: "dallin@openclaw.org", ...enrollment },
        { email: "vincent@openclaw.org" },
      ],
      create: async (value) => {
        created = value;
        return value;
      },
      get: async () => created,
    },
    notify: async () => {},
  });
  const server = createServer((req, res) => {
    void handler(req, res);
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => {
    server.once("listening", resolve);
  });
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const expired = { ...payload, expiresAt: new Date(Date.now() + 3600000).toISOString() };
  const post = (path, identity, body) =>
    fetch(url + path, {
      method: "POST",
      headers: { authorization: `Bearer ${identity}` },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await post("/requests", "publisher", { payload: JSON.stringify(expired) })).status,
    401,
  );
  assert.equal(
    (await post("/requests", "machine", { payload: JSON.stringify(expired) })).status,
    200,
  );
  assert.equal(created.state, "pending");
  const tooLarge = { ...expired, note: "&".repeat(10500) };
  assert.equal(
    (await post("/requests", "machine", { payload: JSON.stringify(tooLarge) })).status,
    413,
  );
  assert.equal(
    (
      await post("/requests", "machine", {
        payload: JSON.stringify({
          ...expired,
          ...Object.fromEntries(
            Array.from({ length: 110 }, (_, index) => [`field${index}`, index]),
          ),
        }),
      })
    ).status,
    413,
  );
  const widgetCount = (card) =>
    card.cardsV2[0].card.sections.reduce((total, section) => total + section.widgets.length, 0);
  const baseCount = widgetCount(
    approvalCard(
      parseRequest({ payload: JSON.stringify(expired) }, Date.now()),
      "https://approval.example/chat",
    ),
  );
  const capacity = {
    ...expired,
    requestId: "00000000-0000-4000-8000-000000000099",
    ...Object.fromEntries(
      Array.from({ length: 100 - baseCount }, (_, index) => [`capacity${index}`, index]),
    ),
  };
  assert.equal(
    widgetCount(
      approvalCard(
        parseRequest({ payload: JSON.stringify(capacity) }, Date.now()),
        "https://approval.example/chat",
      ),
    ),
    100,
  );
  assert.equal(
    (await post("/requests", "machine", { payload: JSON.stringify(capacity) })).status,
    413,
  );
  delete capacity.capacity0;
  assert.equal(
    (await post("/requests", "machine", { payload: JSON.stringify(capacity) })).status,
    200,
  );
  const raw = await new Promise((resolve, reject) => {
    const socket = connect(server.address().port, "127.0.0.1", () => {
      socket.write("GET //[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    });
    let response = "";
    socket.on("data", (chunk) => {
      response += chunk.toString();
    });
    socket.on("end", () => resolve(response));
    socket.on("error", reject);
  });
  assert.match(raw, /^HTTP\/1\.1 400/u);
  assert.equal((await post("/chat", "machine", event())).status, 401);
  assert.equal(
    (await post("/requests/" + payload.requestId + "/approve", "machine", {})).status,
    404,
  );
  assert.equal(
    (
      await fetch(url + "/requests/" + payload.requestId, {
        headers: { authorization: "Bearer publisher" },
      })
    ).status,
    200,
  );
});

await test("real Google verifier rejects missing and forged callback bearer tokens", async () => {
  const verify = googleVerifier();
  await assert.rejects(verify(undefined, "https://approval.example/chat", ["chat-principal"]));
  await assert.rejects(
    verify("Bearer forged", "https://approval.example/chat", ["chat-principal"]),
  );
});

await test("a stale approver DM does not prevent notification of the other approver", async (t) => {
  const attempts = [];
  const handler = createHandler({
    baseUrl: "https://approval.example",
    chatIdentity: "chat-principal",
    requesters: ["machine"],
    readers: [],
    verify: async () => {},
    store: {
      enrollments: async () => [
        { userId: "users/111", space: "spaces/STALE" },
        { userId: "users/222", space: "spaces/ACTIVE" },
      ],
      create: async (value) => value,
    },
    notify: async (space) => {
      attempts.push(space);
      if (space === "spaces/STALE") {
        throw new Error("App removed.");
      }
    },
  });
  const server = createServer((req, res) => {
    void handler(req, res);
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => {
    server.once("listening", resolve);
  });
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/requests`, {
    method: "POST",
    body: JSON.stringify({
      payload: JSON.stringify({
        ...payload,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      }),
    }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(new Set(attempts), new Set(["spaces/ACTIVE", "spaces/STALE"]));
});

await test("generated Reject action settles a fresh request as rejected and reports an existing approval explicitly", async () => {
  const card = approvalCard(request(), "https://approval.example/chat");
  const buttons = card.cardsV2[0].card.sections.at(-1).widgets[0].buttonList.buttons;
  for (const [index, expected] of [
    [0, "approved"],
    [1, "rejected"],
  ]) {
    const action = buttons[index].onClick.action;
    const click = event();
    click.commonEventObject.parameters = Object.fromEntries(
      action.parameters.map(({ key, value }) => [key, value]),
    );
    const store = {
      decide: async (submitted) => {
        const result = settleDecision(request(), submitted, enrollment);
        assert.equal(result.state, expected);
        return {
          ...result,
          lastAttempt: { previousState: "pending", requestedDecision: submitted.decision },
        };
      },
    };
    const response = await handleChat(click, store, now);
    assert.match(response.text, new RegExp(expected, "u"));
    if (expected === "rejected") {
      assert.doesNotMatch(response.text, /approved/u);
    }
    assert.ok(response.cardsV2, "Settled response must replace the actionable card.");
    assert.ok(
      response.cardsV2[0].card.sections.every((section) =>
        section.widgets.every((widget) => !("buttonList" in widget)),
      ),
    );
  }
  const reject = event();
  reject.commonEventObject.parameters.decision = "reject";
  const response = await handleChat(
    reject,
    {
      decide: async () => ({
        ...request(),
        state: "approved",
        lastAttempt: { previousState: "approved", requestedDecision: "rejected" },
      }),
    },
    now,
  );
  assert.match(response.text, /already approved/u);
  assert.match(response.text, /Reject action did not change/u);
});

await test("successful button callbacks replace the original actionable card, not append a misleading confirmation", async (t) => {
  const settled = { ...request(), state: "rejected", lastAttempt: { previousState: "pending" } };
  const handler = createHandler({
    baseUrl: "https://approval.example",
    chatIdentity: "chat-principal",
    requesters: [],
    readers: [],
    verify: async () => {},
    store: { decide: async () => settled },
    notify: async () => {},
  });
  const server = createServer((req, res) => {
    void handler(req, res);
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => {
    server.once("listening", resolve);
  });
  t.after(() => server.close());
  const click = event();
  click.commonEventObject.parameters.decision = "reject";
  const response = await fetch(`http://127.0.0.1:${server.address().port}/chat`, {
    method: "POST",
    body: JSON.stringify(click),
  });
  assert.equal(response.status, 200);
  const action = (await response.json()).hostAppDataAction.chatDataAction;
  assert.equal(action.createMessageAction, undefined);
  assert.match(action.updateMessageAction.message.text, /: rejected\./u);
  assert.match(action.updateMessageAction.message.cardsV2[0].card.header.title, /^REJECTED:/u);
});
