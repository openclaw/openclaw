import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type {
  WhatsAppQaDriverObservedMessage,
  WhatsAppQaDriverSession,
} from "@openclaw/whatsapp/api.js";
import { afterEach, expect, it, vi } from "vitest";
import { fingerprintQaCredentialId } from "../../qa-credentials-fingerprint.runtime.js";
import { readQaScenarioById } from "../../scenario-catalog.js";
import { resolveLiveTransportQaScenarioIds } from "../shared/scenario-selection.js";
import {
  createArchive,
  createDriver,
  observedMessage,
  phones,
  groupJid,
} from "./runtime.test-support.js";
import { gateway, scenario } from "./scenario.test-support.js";
import { parseWhatsAppQaCredentialPayload } from "./whatsapp-live.config.js";
import type { WhatsAppQaMessageScenarioContext as Context } from "./whatsapp-live.contracts.js";
import { isTransientWhatsAppQaDriverError } from "./whatsapp-live.driver.js";
import {
  callWhatsAppGatewayMessageAction,
  callWhatsAppGatewayPoll,
  callWhatsAppGatewaySend,
} from "./whatsapp-live.gateway.js";
import { runWhatsAppStructuredInboundChecks } from "./whatsapp-live.media.js";
import { waitForScenarioObservedMessage } from "./whatsapp-live.observations.js";
import { unpackWhatsAppAuthArchive } from "./whatsapp-live.setup.js";

function messageRun(id: string) {
  const run = scenario(id).buildRun();
  if (run.kind === "approval") {
    throw new Error("Expected message scenario: " + id);
  }
  return run;
}
const fresh = (text: string, extra: Partial<WhatsAppQaDriverObservedMessage> = {}) =>
  observedMessage("reply", { observedAt: new Date().toISOString(), text, ...extra });
function fixture(id: string) {
  const run = messageRun(id);
  const rpc = vi
    .fn<Context["gateway"]["call"]>()
    .mockRejectedValue(new Error("Unexpected Gateway call"));
  const wait = vi
    .fn<WhatsAppQaDriverSession["waitForMessage"]>()
    .mockRejectedValue(new Error("Unexpected driver wait"));
  const send = vi.fn<WhatsAppQaDriverSession["sendText"]>();
  send.mockImplementation(async () => ({ messageId: "driver-" + send.mock.calls.length }));
  const messages: WhatsAppQaDriverObservedMessage[] = [];
  const context: Context = {
    ...phones,
    scenarioId: id,
    sutAccountId: "sut",
    gateway: gateway(rpc),
    gatewayWorkspaceDir: "/tmp/openclaw-whatsapp-qa",
    driver: createDriver({
      sendText: send,
      waitForMessage: wait,
      getObservedMessages: () => messages,
    }),
    gatewayTarget: run.target === "group" ? groupJid : phones.driverPhoneE164,
    target: run.target === "group" ? groupJid : phones.sutPhoneE164,
    targetKind: run.target,
    requestStartedAt: new Date("2026-06-21T12:00:00.000Z"),
    sent: { messageId: "driver-message-1" },
  };
  return {
    run,
    context,
    rpc,
    wait,
    send,
    messages,
    afterSend: () => expectDefined(run.afterSend, "afterSend")(context),
    reply: (value = fresh(String(run.matchText))) =>
      expectDefined(run.afterReply, "afterReply")(value, context),
    verify: (value: WhatsAppQaDriverObservedMessage) =>
      expectDefined(run.verify, "verify")(value, context),
  };
}
function matching(
  match: Parameters<WhatsAppQaDriverSession["waitForMessage"]>[0]["match"],
  accepted: WhatsAppQaDriverObservedMessage,
  ...rejected: WhatsAppQaDriverObservedMessage[]
) {
  expect(rejected.map(match)).toEqual(rejected.map(() => false));
  expect(match(accepted)).toBe(true);
  return accepted;
}
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("can remove copied Signal sessions while preserving other auth archive state", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wa-qa-test-"));
  try {
    const preserved = [
      "creds.json",
      "device-list-15550000001.json",
      "lid-mapping-123_reverse.json",
      "sender-key-120363000@g.us--123_1--5.json",
    ];
    const sessions = ["session-123_1.0.json", "session-123_1.5.json"];
    const entries = Object.fromEntries([...preserved, ...sessions].map((file) => [file, "{}\n"]));
    const archiveBase64 = await createArchive(tempRoot, entries);
    const authDir = await unpackWhatsAppAuthArchive({
      archiveBase64,
      label: "driver",
      parentDir: tempRoot,
    });
    for (const file of preserved) {
      await expect(fs.readFile(path.join(authDir, file), "utf8")).resolves.toBe("{}\n");
    }
    for (const file of sessions) {
      await expect(fs.stat(path.join(authDir, file))).rejects.toMatchObject({ code: "ENOENT" });
    }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

it.each([phones.sutPhoneE164, phones.driverPhoneE164])(
  "validates credential phones: %s",
  (sutPhoneE164) => {
    const payload = {
      driverPhoneE164: "15550000001",
      sutPhoneE164,
      driverAuthArchiveBase64: "driver",
      sutAuthArchiveBase64: "sut",
    };
    if (sutPhoneE164 === phones.driverPhoneE164) {
      expect(() => parseWhatsAppQaCredentialPayload(payload)).toThrow(
        "requires two distinct WhatsApp phone numbers",
      );
    } else {
      expect(parseWhatsAppQaCredentialPayload(payload)).toEqual({ ...payload, ...phones });
    }
  },
);
it("derives a stable non-secret credential fingerprint", () => {
  expect(fingerprintQaCredentialId("cred-stale-row")).toMatch(/^sha256:[0-9a-f]{16}$/);
  expect(fingerprintQaCredentialId(undefined)).toBeUndefined();
});

it("runs group media, audio and poll probes against the group target", async () => {
  const shapes: Partial<WhatsAppQaDriverObservedMessage>[] = [
    { kind: "media", hasMedia: true, mediaType: "image/png" },
    {
      kind: "media",
      hasMedia: true,
      mediaType: "application/pdf",
      mediaFileName: "whatsapp-qa-group.pdf",
    },
    { kind: "media", hasMedia: true, mediaType: "audio/ogg; codecs=opus" },
    {},
    { kind: "poll", poll: { options: ["alpha", "beta"] } },
  ];
  const messages = shapes.map((shape, i) =>
    fresh("", { ...shape, fromJid: groupJid, messageId: "group-" + i }),
  );
  const calls: Array<[string, unknown]> = [];
  for (const kind of ["media", "audio", "poll"]) {
    const f = fixture("whatsapp-group-outbound-" + kind);
    f.wait.mockImplementation(async ({ match }) =>
      expectDefined(messages.find(match), "group observation"),
    );
    f.rpc.mockImplementation(async (method, payload) => {
      calls.push([method, payload]);
      const { message, question } = payload as Record<string, unknown>;
      const update = (i: number, patch: Partial<WhatsAppQaDriverObservedMessage>) =>
        Object.assign(
          expectDefined(messages[i], "message"),
          { observedAt: new Date().toISOString() },
          patch,
        );
      if (typeof question === "string" && question) {
        update(4, { poll: { options: ["alpha", "beta"], question } });
      }
      if (typeof message === "string") {
        if (message.endsWith("_IMAGE")) {
          update(0, { text: message });
        }
        if (message.endsWith("_DOCUMENT")) {
          update(1, { text: message });
        }
        if (message.endsWith("_AUDIO")) {
          update(2, {});
          update(3, { text: message });
        }
      }
      return {};
    });
    await f.reply();
  }
  expect(calls.map(([method]) => method)).toEqual(["send", "send", "send", "poll"]);
  expect(calls.map(([, payload]) => payload)).toMatchObject(
    Array.from({ length: 4 }, () => ({ to: groupJid })),
  );
});

it("isolates quoted and fresh Gateway sends", async () => {
  const f = fixture("whatsapp-reply-context-isolation");
  f.rpc.mockResolvedValue({});
  f.wait.mockImplementation(async ({ match }) => {
    const payload = f.rpc.mock.calls.at(-1)?.[1] as { message: string };
    const reply = fresh(payload.message);
    return f.wait.mock.calls.length === 1
      ? matching(match, { ...reply, quoted: { messageId: "driver-message-1" } }, reply, {
          ...reply,
          quoted: { messageId: "wrong-trigger" },
        })
      : matching(match, reply, { ...reply, text: "wrong fresh marker" });
  });
  await f.reply();
  expect(
    f.rpc.mock.calls.map(([, payload]) => (payload as { replyToId?: string }).replyToId),
  ).toEqual(["driver-message-1", undefined]);
  expect(f.wait).toHaveBeenCalledTimes(2);
});

it("quotes the second queued message in batched reply-to mode", async () => {
  const f = fixture("whatsapp-reply-to-mode-batched");
  f.context.sent.messageId = "first-batched-message";
  f.send.mockResolvedValue({ messageId: "second-batched-message" });
  await f.afterSend();
  const first = f.run.input.match(/\bWHATSAPP_QA_BATCHED_FIRST_[A-Z0-9]+\b/u)?.[0];
  expect(first).toEqual(expect.any(String));
  expect(f.send.mock.calls[0]?.[1]).toContain(String(f.run.matchText));
  expect(f.send.mock.calls[0]?.[1]).not.toContain(first);
  expect(() =>
    f.verify(fresh("", { quoted: { messageId: "second-batched-message" } })),
  ).not.toThrow();
});

it("waits for upload-file media", async () => {
  const f = fixture("whatsapp-agent-message-action-upload-file");
  const token = expectDefined(
    /\bWHATSAPP_QA_AGENT_UPLOAD_[A-Z0-9]+\b/u.exec(f.run.input)?.[0],
    "upload token",
  );
  const media = Promise.withResolvers<WhatsAppQaDriverObservedMessage>();
  f.wait.mockReturnValue(media.promise);
  let settled = false;
  const pending = f.afterSend().then((result) => {
    settled = true;
    return result;
  });
  await Promise.resolve();
  expect(f.wait).toHaveBeenCalledOnce();
  expect(settled).toBe(false);
  media.resolve(fresh(token, { kind: "media", hasMedia: true, mediaType: "image/png" }));
  expect(await pending).toContain("upload-file media");
});

it.each([true, false])("validates status reaction ordering: %s", async (ordered) => {
  const f = fixture("whatsapp-status-reaction-lifecycle");
  f.messages.push(
    ...(ordered ? ["👀", "✅"] : ["✅", "👀"]).map((emoji, index) =>
      observedMessage("reaction-" + index, {
        kind: "reaction",
        text: "",
        observedAt: `2026-06-21T12:00:0${index + 1}.000Z`,
        reaction: { emoji, messageId: "driver-message-1" },
      }),
    ),
  );
  vi.useFakeTimers({ now: new Date("2026-06-21T12:00:00.000Z") });
  const result = f.reply(observedMessage("reply", { observedAt: "2026-06-21T12:00:03.000Z" }));
  const outcome = ordered
    ? expect(result).resolves.toContain("👀 -> ✅")
    : expect(result).rejects.toThrow("timed out waiting for WhatsApp status reaction sequence");
  await vi.runAllTimersAsync();
  await outcome;
});

it("routes Gateway DM helper calls to the driver", async () => {
  const f = fixture("whatsapp-reply-context-isolation");
  f.rpc.mockResolvedValue({});
  await callWhatsAppGatewaySend(f.context, {
    label: "quoted",
    message: "WHATSAPP_QA_QUOTED",
    replyToId: "driver-message-1",
  });
  await callWhatsAppGatewayPoll(f.context, {
    label: "poll",
    options: ["alpha", "beta"],
    question: "WHATSAPP_QA_POLL",
  });
  await callWhatsAppGatewayMessageAction(f.context, {
    action: "react",
    label: "react",
    params: { emoji: "👍", messageId: "driver-message-1" },
  });
  expect(f.rpc.mock.calls.map(([, payload]) => payload)).toMatchObject([
    { to: phones.driverPhoneE164 },
    { to: phones.driverPhoneE164 },
    {
      params: { emoji: "👍", messageId: "driver-message-1", to: phones.driverPhoneE164 },
      conversationReadOrigin: "direct-operator",
    },
  ]);
});
it("derives live-frontier selection from taxonomy and provider eligibility", () => {
  const scenarioIds = resolveLiveTransportQaScenarioIds({
    channelId: "whatsapp",
    providerMode: "live-frontier",
    supportsModuleFlows: true,
  });

  expect(scenarioIds).toContain("whatsapp-canary");
  expect(scenarioIds).toContain("whatsapp-mention-gating");
  expect(scenarioIds).not.toContain("whatsapp-native-new-command");
});

it.each([false, true])(
  "restores mention gating after activation (failure=%s)",
  async (failProbe) => {
    const f = fixture("whatsapp-group-activation-always");
    expect(f.run).toMatchObject({ target: "group", input: "/activation always" });
    const always = /\bWHATSAPP_QA_ACTIVATION_ALWAYS_[A-Z0-9]+\b/u;
    const quiet = /\bWHATSAPP_QA_ACTIVATION_QUIET_[A-Z0-9]+\b/u;
    const sends = () => f.send.mock.calls;
    const restoreIndex = () =>
      sends().findIndex(([to, text]) => to === groupJid && text.trim() === "/activation mention");
    let alwaysMatched = false,
      quietReads = 0;
    f.context.driver.getObservedMessages = () => {
      if (sends().some(([, text]) => quiet.test(text))) {
        quietReads++;
      }
      return [];
    };
    f.wait.mockImplementation(async ({ match }) => {
      const restoring = restoreIndex() >= 0;
      if (failProbe && !restoring) {
        throw new Error("forced always-mode probe failure");
      }
      const probe = sends().findLast(
        ([, text]) => always.test(text) && !/\bopenclawqa\b/iu.test(text),
      );
      const reply = fresh(
        restoring ? "Activation: mention" : expectDefined(probe, "always probe")[1],
        { fromJid: groupJid },
      );
      const rejected = restoring
        ? []
        : [{ ...reply, text: reply.text.replace(always, "WHATSAPP_QA_ACTIVATION_ALWAYS_WRONG") }];
      matching(match, reply, ...rejected);
      if (!restoring) {
        alwaysMatched = true;
      }
      return reply;
    });
    vi.useFakeTimers({ now: new Date("2026-06-21T12:00:02.000Z") });
    const result = f.reply(fresh("Activation: always", { fromJid: groupJid }));
    const outcome = failProbe
      ? expect(result).rejects.toThrow("forced always-mode probe failure")
      : result;
    await vi.runAllTimersAsync();
    await outcome;
    expect(restoreIndex()).toBeGreaterThanOrEqual(0);
    if (!failProbe) {
      for (const probe of [
        sends().find(([, text]) => always.test(text)),
        sends()
          .slice(restoreIndex() + 1)
          .find(([, text]) => quiet.test(text)),
      ]) {
        expect(probe?.[0]).toBe(groupJid);
        expect(probe?.[1]).not.toMatch(/\bopenclawqa\b/i);
      }
      expect(alwaysMatched).toBe(true);
      expect(quietReads).toBeGreaterThan(0);
    }
  },
);

it("quotes the SUT reply without a mention for reply-to-bot activation", async () => {
  const f = fixture("whatsapp-group-reply-to-bot-triggers");
  expect(f.run.target).toBe("group");
  expect(f.run.input).toMatch(/\bopenclawqa\b/iu);
  expect(f.run.input).toMatch(/\bWHATSAPP_QA_REPLY_TO_BOT_SEED_[A-Z0-9]+\b/u);
  f.wait.mockImplementation(async ({ match }) => {
    const trigger = f.send.mock.calls.find((call) => call[2]?.quotedMessageKey);
    const marker = expectDefined(
      /\bWHATSAPP_QA_REPLY_TO_BOT_TRIGGER_[A-Z0-9]+\b/u.exec(trigger?.[1] ?? "")?.[0],
      "trigger marker",
    );
    const candidate = fresh(marker, { fromJid: groupJid });
    return matching(
      match,
      { ...candidate, quoted: { messageId: "driver-1" } },
      { ...candidate, text: "WHATSAPP_QA_REPLY_TO_BOT_TRIGGER_WRONG" },
      candidate,
    );
  });
  const seed = fresh("WHATSAPP_QA_REPLY_TO_BOT_SEED_TEST", {
    messageId: "sut-seed-reply",
    fromJid: groupJid,
    participantJid: "15550000002@s.whatsapp.net",
  });
  await f.reply(seed);
  const [to, text, options] = expectDefined(
    f.send.mock.calls.find((call) => call[2]?.quotedMessageKey),
    "quoted send",
  );
  expect(to).toBe(groupJid);
  expect(text).toMatch(/\bWHATSAPP_QA_REPLY_TO_BOT_TRIGGER_[A-Z0-9]+\b/u);
  expect(text).not.toMatch(/\bopenclawqa\b|@\d/iu);
  expect(options?.quotedMessageKey).toMatchObject({
    fromMe: false,
    id: seed.messageId,
    messageText: seed.text,
    participant: seed.participantJid,
    remoteJid: groupJid,
  });
  expect(f.wait).toHaveBeenCalledOnce();
});

it.each(["dm", "group"] as const)("verifies quoted %s replies", (target) => {
  const f = fixture(
    target === "dm" ? "whatsapp-reply-to-message" : "whatsapp-group-reply-to-message",
  );
  expect([scenario(f.context.scenarioId).requiresGroupJid, f.run.target]).toEqual([
    target === "group" ? true : undefined,
    target,
  ]);
  if (target === "dm") {
    expect(f.run.input).not.toContain("openclawqa");
  } else {
    expect(f.run.input).toMatch(/^openclawqa\b/u);
  }
  const reply = fresh("reply");
  expect(() => f.verify({ ...reply, quoted: { messageId: "driver-message-1" } })).not.toThrow();
  expect(() => f.verify(reply)).toThrow("expected reply quote driver-message-1, got <missing>");
});

it("seeds structured inbound context and sends a routable contact", async () => {
  const run = messageRun("whatsapp-inbound-structured-messages");
  for (const text of [
    "37.774900, -122.419400",
    "WhatsApp location marker",
    "WhatsApp contact marker",
    "WhatsApp sticker marker",
    "exact marker before structured inbound checks",
  ]) {
    expect(run.input).toContain(text);
  }
  const sent = async () => ({ messageId: "structured-1" });
  const sendContact = vi.fn(sent);
  await runWhatsAppStructuredInboundChecks({
    ...phones,
    target: phones.sutPhoneE164,
    driver: createDriver({
      sendContact,
      sendLocation: sent,
      sendMedia: sent,
      sendSticker: sent,
    }),
    contactToken: "CONTACT_TOKEN",
    documentToken: "DOCUMENT_TOKEN",
    locationToken: "LOCATION_TOKEN",
    stickerToken: "STICKER_TOKEN",
    waitForStructuredReply: async () => {},
  });
  expect(sendContact).toHaveBeenCalledWith(
    phones.sutPhoneE164,
    expect.objectContaining({ vcard: expect.stringContaining("waid=15550000001:+15550000001") }),
  );
});

it.each([false, true])(
  "reports observation diagnostics with unresolved sender=%s",
  async (unresolved) => {
    const f = fixture("whatsapp-group-pending-history-context");
    if (unresolved) {
      f.messages.push(fresh(String(f.run.matchText), { fromJid: groupJid, fromPhoneE164: null }));
    }
    f.wait.mockImplementation(async ({ match }) => {
      if (unresolved) {
        expect(match(expectDefined(f.messages[0], "unresolved observation"))).toBe(false);
      }
      throw new Error("timed out waiting for WhatsApp QA driver message");
    });
    await expect(
      waitForScenarioObservedMessage(f.context, {
        observedAfter: f.context.requestStartedAt,
        match: (message) => message.text.includes(String(f.run.matchText)),
      }),
    ).rejects.toThrow(
      unresolved
        ? "fromExpectedSut=no"
        : "observed 0 WhatsApp driver message(s) after wait lower bound",
    );
  },
);

it("requires the second delivery chunk's tail marker and quote", async () => {
  const f = fixture("whatsapp-reply-delivery-shape"),
    token = String(f.run.matchText);
  f.rpc.mockResolvedValue({});
  const chunk = (text: string, quoted = true) =>
    fresh(text, {
      messageId: text,
      ...(quoted ? { quoted: { messageId: "driver-message-1" } } : {}),
    });
  f.wait.mockImplementation(async ({ match }) =>
    f.wait.mock.calls.length === 1
      ? matching(match, chunk(token + "_LONG_BEGIN"))
      : matching(
          match,
          chunk(token + "_LONG_END"),
          chunk("missing tail"),
          chunk(token + "_LONG_END", false),
        ),
  );
  await f.reply();
  expect(f.wait).toHaveBeenCalledTimes(2);
});

it("defines final-message accounting", () => {
  expect(messageRun("whatsapp-stream-final-message-accounting")).toMatchObject({
    input: expect.stringContaining("WhatsApp long final QA check"),
    matchText: "WHATSAPP-LONG-FINAL-BEGIN",
    expectedJoinedSutTextIncludes: ["WHATSAPP-LONG-FINAL-BEGIN", "WHATSAPP-LONG-FINAL-END"],
    expectedSutMessageCount: 2,
    settleMs: 4_000,
  });
});
it("defines automatic visible mention-gated replies", () => {
  const run = messageRun("whatsapp-mention-gating");
  expect(run.input).toContain("openclawqa reply with only this exact marker");
  expect(run.input).not.toContain("visible reply tool check");
});

it.each([false, true])("defines captionless audio with group=%s", (group) => {
  const id = group ? "whatsapp-group-audio-gating" : "whatsapp-audio-preflight";
  const run = messageRun(id);
  const audio = (fileName: string) => ({
    fileName,
    kind: "media",
    mediaType: "audio/ogg; codecs=opus",
  });
  if (group) {
    expect(run.quietMatchText).toBeUndefined();
    expect(run).toMatchObject({
      input: "",
      quietInput: "",
      matchText: "WHATSAPP_QA_GROUP_AUDIO_TRANSCRIPT_OK",
      sendMode: audio("whatsapp-qa-group-audio.ogg"),
      quietSendMode: audio("whatsapp-qa-group-audio-quiet.ogg"),
    });
    const trigger = Buffer.from("OPENCLAW_QA_GROUP_AUDIO_TRIGGER");
    expect(run.sendMode?.kind === "media" && run.sendMode.mediaBuffer.includes(trigger)).toBe(true);
    expect(
      run.quietSendMode?.kind === "media" &&
        run.quietSendMode.mediaBuffer.length === 1_303 &&
        !run.quietSendMode.mediaBuffer.includes(trigger),
    ).toBe(true);
  } else {
    expect(readQaScenarioById(id).plugins).toEqual(["openai"]);
    expect(run).toMatchObject({
      expectReply: true,
      matchText: "WHATSAPP_QA_AUDIO_TRANSCRIPT_OK",
      sendMode: audio("whatsapp-qa-audio.ogg"),
    });
    expect(run.sendMode?.kind === "media" && run.sendMode.mediaBuffer.length).toBe(1_303);
  }
});

it.each([
  ["Connection Closed", true],
  ["status 440: session conflict", true],
  ["Stream Errored (conflict)", true],
  ["timed out after 45000ms waiting for WhatsApp QA driver pending notifications", true],
  ["timed out waiting for WhatsApp QA driver message", false],
  ["timed out waiting", false],
] as const)("classifies driver error %s", (message, retryable) => {
  expect(isTransientWhatsAppQaDriverError(new Error(message))).toBe(retryable);
});
