import assert from "node:assert/strict";
import test from "node:test";
import {
  parseRecorderReady,
  parseScenario,
  resolveChatTarget,
  selectChatTarget,
} from "./scenario.mjs";

const actions = (...values) => parseScenario({ actions: values }).actions;
const rejects = (action, pattern) => assert.throws(() => actions(action), pattern);

test("normalizes Telegram and gateway actions", () => {
  const input = [
    { type: "send", text: "@{sut} first", awaitReply: { text: "BEFORE", requireQuote: true } },
    {
      type: "click",
      atMs: 500,
      messageText: "Select a provider",
      buttonText: "OpenAI",
    },
    { type: "patchConfig", atMs: 750, patch: { channels: { telegram: { historyLimit: 9 } } } },
    { type: "systemEvent", atMs: 900, text: "heartbeat proof" },
    { type: "cron", atMs: 950, message: "deliver the schedule", bestEffort: true },
    { type: "command", atMs: 975, argv: ["node", "--version"], cwd: "repo" },
    { type: "telegramApiHold", atMs: 980, method: "sendMessage", skip: 1 },
    { type: "telegramApiWaitHeld", atMs: 990, method: "sendMessage" },
    { type: "telegramApiRelease", atMs: 1_000 },
    { type: "restartGateway", atMs: 1_000, graceMs: 20_000 },
    { type: "followupDrainHold", atMs: 1_100, sessionKey: "agent:main:main" },
    { type: "followupDrainWaitHeld", atMs: 1_200 },
    { type: "followupDrainRelease", atMs: 1_400 },
  ];
  const defaults = [
    { atMs: 0 },
    { timeoutMs: 15_000 },
    {},
    {},
    {},
    { timeoutMs: 60_000 },
    {},
    { timeoutMs: 30_000 },
    {},
    {},
    { timeoutMs: 60_000 },
    { timeoutMs: 60_000 },
    { timeoutMs: 60_000 },
  ];
  const expected = structuredClone(input).map((action, index) =>
    Object.assign(action, defaults[index]),
  );
  assert.deepEqual(parseScenario({ actions: input, health: {} }), {
    actions: expected,
    health: { intervalMs: 250, timeoutMs: 1_000 },
  });
});

test("stably sorts actions by timestamp", () => {
  assert.deepEqual(
    parseScenario({
      actions: [
        { type: "send", atMs: 1_000, text: "late" },
        { type: "send", atMs: 0, text: "early" },
        { type: "send", atMs: 1_000, text: "same-time" },
      ],
    }).actions,
    [
      { type: "send", atMs: 0, text: "early" },
      { type: "send", atMs: 1_000, text: "late" },
      { type: "send", atMs: 1_000, text: "same-time" },
    ],
  );
});

test("rejects fields and action types outside the closed schema", () => {
  for (const [action, pattern] of [
    [{ type: "shell", command: "true" }, /not a supported scenario action/u],
    [
      { type: "command", argv: ["node"], cwd: "elsewhere" },
      /cwd must be repo, workspace, state, or root/u,
    ],
    [{ type: "send", text: "hello", delayMs: 1 }, /unknown field: delayMs/u],
    [{ type: "restartGateway", atMs: -1 }, /atMs must be a non-negative integer/u],
    [{ type: "cron", message: "deliver", bestEffort: "yes" }, /bestEffort must be a boolean/u],
  ]) {
    rejects(action, pattern);
  }
  const send = { type: "send", text: "request", awaitReply: { text: "SAME" } };
  assert.throws(() => parseScenario({ actions: [send, send] }), /must be distinct/);
  for (const awaitReply of [
    { text: "" },
    { text: "X", requireQuote: false },
    { text: "X", timeoutMs: 100 },
  ]) {
    rejects({ ...send, awaitReply }, /awaitReply/);
  }
});

test("validates the recorder-ready artifact as a closed shape", () => {
  assert.deepEqual(
    parseRecorderReady({ schemaVersion: 1, startedAtUnixMs: 1_786_900_000_000, chatId: -1001 }),
    { schemaVersion: 1, startedAtUnixMs: 1_786_900_000_000, chatId: -1001 },
  );
  assert.throws(
    () => parseRecorderReady({ schemaVersion: 1, startedAtUnixMs: 1, chatId: -1001, extra: true }),
    /unknown field: extra/u,
  );
});

test("projects DM and group recording targets into cron delivery targets", () => {
  assert.deepEqual(selectChatTarget({ dm: true, sutUsername: "sut_bot", testerId: 42 }), {
    kind: "dm",
    recorderSelector: "@sut_bot",
    cronDeliveryTarget: "42",
  });

  const group = selectChatTarget({
    dm: false,
    explicitChat: "",
    leasedGroupId: "-100123",
    sutUsername: "sut_bot",
    testerId: 42,
  });
  assert.deepEqual(group, {
    kind: "chat",
    recorderSelector: "-100123",
    cronDeliveryTarget: null,
  });
  assert.deepEqual(resolveChatTarget(group, -100123), {
    kind: "chat",
    recorderSelector: "-100123",
    cronDeliveryTarget: "-100123",
  });
});

test("forum topic selection survives scenario parsing and rejects invalid topic ids", () => {
  const action = { type: "send", atMs: 0, text: "topic proof", forumTopicId: 42 };
  assert.deepEqual(actions(action), [action]);
  for (const forumTopicId of [0, -1, 1.5]) {
    rejects({ ...action, forumTopicId }, /forumTopicId/);
  }
});

test("photo sends allow an empty caption and replyToPrevious targets an earlier send", () => {
  const photo = { type: "send", atMs: 0, photo: "/tmp/fixture.png" };
  const reply = { type: "send", atMs: 5, text: "/btw check this", replyToPrevious: true };
  assert.deepEqual(actions(photo, reply), [{ ...photo, text: "" }, reply]);
  assert.deepEqual(actions(reply, photo), [{ ...photo, text: "" }, reply]);
  assert.throws(() => actions({ ...photo, atMs: 10 }, reply), /replyToPrevious/);
  rejects(reply, /replyToPrevious/);
  rejects({ type: "send", atMs: 0, text: "x", replyToPrevious: false }, /replyToPrevious/);
  rejects({ type: "send", atMs: 0 }, /text/);
});

test("album sends normalize photos with an optional caption and enforce Telegram bounds", () => {
  const album = { type: "send", atMs: 0, photos: ["/tmp/a.png", "/tmp/b.png"] };
  assert.deepEqual(actions(album), [{ ...album, text: "" }]);
  assert.deepEqual(actions({ ...album, text: "caption" }), [{ ...album, text: "caption" }]);
  for (const photos of [[], ["/tmp/a.png"], Array(11).fill("/tmp/a.png"), "/tmp/a.png"]) {
    rejects({ ...album, photos }, /photos must be an array of 2-10 photo paths/);
  }
  rejects({ ...album, photos: ["/tmp/a.png", " "] }, /photos\[1\] must be a non-empty string/);
  rejects({ ...album, photo: "/tmp/c.png" }, /photo or photos, not both/);
});

test("forward bursts normalize and support a later replyToPrevious after sorting", () => {
  const burst = { type: "forwardBurst", text: "forwarded text", photo: "/tmp/fixture.png" };
  const reply = { type: "send", atMs: 5, text: "follow-up", replyToPrevious: true };
  assert.deepEqual(actions(reply, burst), [{ ...burst, atMs: 0 }, reply]);
  assert.throws(() => actions(reply, { ...burst, atMs: 10 }), /replyToPrevious/);
});

test("forward bursts require text and photo and reject unknown keys", () => {
  const burst = { type: "forwardBurst", text: "forwarded text", photo: "/tmp/fixture.png" };
  for (const key of ["text", "photo"]) {
    for (const value of [undefined, "", " ", 42]) {
      rejects({ ...burst, [key]: value }, new RegExp(`${key} must be a non-empty string`));
    }
  }
  for (const key of ["extra", "awaitReply", "forumTopicId"]) {
    rejects({ ...burst, [key]: true }, new RegExp(`unknown field: ${key}`));
  }
});
