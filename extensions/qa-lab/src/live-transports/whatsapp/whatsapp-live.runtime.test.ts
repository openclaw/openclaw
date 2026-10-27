import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type {
  WhatsAppQaDriverObservedMessage,
  WhatsAppQaDriverSession,
} from "@openclaw/whatsapp/api.js";
import { WhatsAppChannelConfigSchema } from "@openclaw/whatsapp/channel-config-api.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { fingerprintQaCredentialId } from "../../qa-credentials-fingerprint.runtime.js";
import { readQaScenarioById } from "../../scenario-catalog.js";
import {
  createArchive,
  createDriver,
  observedMessage,
  phones,
  runtimeEnv,
  groupJid,
} from "./runtime.test-support.js";
import { runWhatsAppScenario } from "./scenario-runtime.js";
import {
  environment,
  gateway as makeGateway,
  scenario as getScenario,
} from "./scenario.test-support.js";
import { parseWhatsAppQaCredentialPayload } from "./whatsapp-live.config.js";
import type { WhatsAppQaMessageScenarioContext as Context } from "./whatsapp-live.contracts.js";
import { isTransientWhatsAppQaDriverError } from "./whatsapp-live.driver.js";
import { callWhatsAppGatewayMessageAction } from "./whatsapp-live.gateway.js";
import { runWhatsAppStructuredInboundChecks } from "./whatsapp-live.media.js";
import { waitForScenarioObservedMessage } from "./whatsapp-live.observations.js";
import { unpackWhatsAppAuthArchive } from "./whatsapp-live.setup.js";

function messageRun(id: string) {
  const run = getScenario(id).buildRun();
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
    gateway: makeGateway(rpc),
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

it.each(["media", "audio", "poll"])(
  "observes group outbound %s at the group target",
  async (kind) => {
    const f = fixture("whatsapp-group-outbound-" + kind);
    const messages: WhatsAppQaDriverObservedMessage[] = [];
    f.wait.mockImplementation(async ({ match }) =>
      expectDefined(messages.find(match), "group observation"),
    );
    f.rpc.mockImplementation(async (_method, payload) => {
      expect(_method).toBe(kind === "poll" ? "poll" : "send");
      expect(payload).toHaveProperty("to", groupJid);
      const { message, question } = payload as Record<string, unknown>;
      const observe = (text: string, shape: Partial<WhatsAppQaDriverObservedMessage>) =>
        messages.push(fresh(text, { fromJid: groupJid, ...shape }));
      if (typeof question === "string" && question) {
        observe("", { kind: "poll", poll: { options: ["alpha", "beta"], question } });
      }
      if (typeof message === "string") {
        expect(message).toMatch(/_(?:IMAGE|DOCUMENT|AUDIO)$/);
        const audio = message.endsWith("_AUDIO");
        const mediaType = audio
          ? "audio/ogg; codecs=opus"
          : message.endsWith("_IMAGE")
            ? "image/png"
            : "application/pdf";
        observe(audio ? "" : message, { kind: "media", hasMedia: true, mediaType });
        if (audio) {
          observe(message, {});
        }
      }
      return {};
    });
    await f.reply();
    expect(messages).toHaveLength(kind === "poll" ? 1 : 2);
  },
);

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

it("routes operator message actions to the driver", async () => {
  const f = fixture("whatsapp-reply-context-isolation");
  f.rpc.mockResolvedValue({});
  await callWhatsAppGatewayMessageAction(f.context, {
    action: "react",
    label: "react",
    params: { emoji: "👍", messageId: "driver-message-1" },
  });
  expect(f.rpc.mock.calls.map(([, payload]) => payload)).toMatchObject([
    {
      params: { emoji: "👍", messageId: "driver-message-1", to: phones.driverPhoneE164 },
      conversationReadOrigin: "direct-operator",
    },
  ]);
});
it.each([false, true])(
  "restores mention gating after activation (failure=%s)",
  async (failProbe) => {
    const f = fixture("whatsapp-group-activation-always");
    const always = /\bWHATSAPP_QA_ACTIVATION_ALWAYS_[A-Z0-9]+\b/u;
    let restored = false;
    f.send.mockImplementation(async (to, text) => {
      expect(to).toBe(groupJid);
      expect(text).not.toMatch(/\bopenclawqa\b/i);
      if (text.trim() === "/activation mention") {
        restored = true;
      }
      return {};
    });
    const observe = vi.fn(() => {
      expect(restored).toBe(true);
      expect(f.send.mock.lastCall?.[1]).toMatch(/WHATSAPP_QA_ACTIVATION_QUIET_/);
      return [];
    });
    f.context.driver.getObservedMessages = observe;
    f.wait.mockImplementation(async ({ match }) => {
      if (failProbe && !restored) {
        throw new Error("forced always-mode probe failure");
      }
      const reply = fresh(
        restored ? "Activation: mention" : expectDefined(f.send.mock.lastCall, "always probe")[1],
        { fromJid: groupJid },
      );
      const rejected = restored
        ? []
        : [{ ...reply, text: reply.text.replace(always, "WHATSAPP_QA_ACTIVATION_ALWAYS_WRONG") }];
      return matching(match, reply, ...rejected);
    });
    vi.useFakeTimers({ now: new Date("2026-06-21T12:00:02.000Z") });
    const result = f.reply(fresh("Activation: always", { fromJid: groupJid }));
    const outcome = failProbe
      ? expect(result).rejects.toThrow("forced always-mode probe failure")
      : result;
    await vi.runAllTimersAsync();
    await outcome;
    expect(restored).toBe(true);
    expect(f.wait).toHaveBeenCalledTimes(2);
    if (!failProbe) {
      expect(observe).toHaveBeenCalled();
    }
  },
);

it("quotes the SUT reply without a mention for reply-to-bot activation", async () => {
  const f = fixture("whatsapp-group-reply-to-bot-triggers");
  expect(f.run.input).toMatch(/\bopenclawqa\b/iu);
  const quotedSend = () =>
    expectDefined(
      f.send.mock.calls.find((call) => call[2]?.quotedMessageKey),
      "quoted send",
    );
  f.wait.mockImplementation(async ({ match }) => {
    const candidate = fresh(quotedSend()[1], { fromJid: groupJid });
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
  const [to, text, options] = quotedSend();
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
  const reply = fresh("reply");
  expect(() => f.verify({ ...reply, quoted: { messageId: "driver-message-1" } })).not.toThrow();
  expect(() => f.verify(reply)).toThrow("expected reply quote driver-message-1, got <missing>");
});

it("seeds structured inbound context and sends a routable contact", async () => {
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

it.each([
  ["Connection Closed", true],
  ["status 440: session conflict", true],
  ["timed out after 45000ms waiting for WhatsApp QA driver pending notifications", true],
  ["timed out waiting for WhatsApp QA driver message", false],
] as const)("classifies driver error %s", (message, retryable) => {
  expect(isTransientWhatsAppQaDriverError(new Error(message))).toBe(retryable);
});

const readyAccount = (accountId: string, lastConnectedAt = Date.now() - 30_000) => ({
  accountId,
  lastConnectedAt,
  connected: true,
  running: true,
});

it("targets group approval reactions at the approval prompt participant", async () => {
  const implementation = getScenario("whatsapp-approval-exec-group-reaction-native");
  const run = implementation.buildRun();
  if (run.kind !== "approval") {
    throw new Error("expected approval scenario run");
  }
  const sendReaction = vi.fn(async () => ({ messageId: "reaction-1" }));
  let approvalId = "";
  let waitCount = 0;
  const driver = createDriver({
    sendReaction,
    waitForMessage: async ({ match }) => {
      waitCount += 1;
      const isPending = waitCount === 1;
      const message = observedMessage(isPending ? "approval-message-1" : "approval-resolved-1", {
        fromJid: "12345@g.us",
        observedAt: isPending ? "2026-06-28T02:00:00.000Z" : "2026-06-28T02:00:01.000Z",
        participantJid: "999@lid",
        text: isPending
          ? `Exec approval required\nID: ${approvalId}\n${run.token}\nReact with: 👍`
          : `✅ Exec approval allow-once. ID: ${approvalId}`,
      });
      expect(match(message)).toBe(true);
      return message;
    },
  });
  const gateway = makeGateway(async (method, payload) => {
    if (method === "exec.approval.request") {
      assert(payload && typeof payload === "object" && "id" in payload);
      assert(typeof payload.id === "string");
      approvalId = payload.id;
      return { id: approvalId, status: "accepted" };
    }
    if (method === "exec.approval.waitDecision") {
      return { decision: "allow-once" };
    }
    throw new Error(`unexpected gateway call ${method}`);
  });

  await runWhatsAppScenario({
    preparedScenario: { implementation, run },
    driverAuthDir: "/qa/driver",
    getDriver: () => driver,
    replaceDriver: async () => {},
    gateway,
    runtimeEnv: { ...runtimeEnv, groupJid: "12345@g.us" },
    scenario: implementation,
    sutAccountId: "work",
  });

  expect(sendReaction).toHaveBeenCalledWith("12345@g.us", "approval-message-1", "👍", {
    fromMe: false,
    participant: "999@lid",
  });
});

it.each([
  { scenarioId: "whatsapp-group-allowlist-block", quietMs: 8_000, fault: "none" },
  { scenarioId: "whatsapp-group-allowlist-block", quietMs: 8_000, fault: "reply" },
  { scenarioId: "whatsapp-group-allowlist-block", quietMs: 8_000, fault: "unknown sender" },
  { scenarioId: "whatsapp-mention-gating", quietMs: 5_000, fault: "none" },
  { scenarioId: "whatsapp-mention-gating", quietMs: 5_000, fault: "reply" },
  { scenarioId: "whatsapp-agent-message-action-react", quietMs: 8_000, fault: "none" },
  { scenarioId: "whatsapp-agent-message-action-react", quietMs: 8_000, fault: "reply" },
  { scenarioId: "whatsapp-group-agent-message-action-react", quietMs: 8_000, fault: "none" },
])(
  "observes the complete $scenarioId quiet window (fault: $fault)",
  async ({ scenarioId, quietMs, fault }) => {
    vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z") });
    const startedAt = Date.now();
    const implementation = getScenario(scenarioId);
    const run = implementation.buildRun();
    assert(run.kind !== "approval");
    const targetJid = scenarioId.startsWith("whatsapp-agent-") ? phones.sutPhoneE164 : groupJid;
    const sends: number[] = [];
    const messages: WhatsAppQaDriverObservedMessage[] = [];
    const driver = createDriver({
      getObservedMessages: () => messages,
      sendText: async (target, text) => {
        expect(target).toBe(targetJid);
        sends.push(Date.now() - startedAt);
        if (scenarioId === "whatsapp-mention-gating" && sends.length === 2) {
          expect(text).toMatch(/^openclawqa\b/);
        }
        if (scenarioId.endsWith("action-react")) {
          messages.push(
            fresh("", {
              kind: "reaction",
              fromJid: target,
              observedAt: new Date(Date.now() + 1).toISOString(),
              reaction: { emoji: "👍", messageId: "qa-inbound" },
            }),
          );
        }
        return { messageId: "qa-inbound" };
      },
      waitForMessage: async ({ match }) => {
        const reply = messages.find(match) ?? fresh(run.input, { fromJid: targetJid });
        if (reply.kind === "reaction") {
          const reaction = expectDefined(reply.reaction, "native reaction");
          return matching(
            match,
            reply,
            {
              ...reply,
              ...(scenarioId.startsWith("whatsapp-group-")
                ? { fromJid: "other@g.us" }
                : { fromPhoneE164: "+15550000003" }),
            },
            { ...reply, reaction: { ...reaction, emoji: "👎" } },
            { ...reply, reaction: { ...reaction, messageId: "other-message" } },
          );
        }
        expect(match(reply)).toBe(true);
        return reply;
      },
    });
    let settled = false;
    const result = runWhatsAppScenario({
      preparedScenario: { implementation, run },
      getDriver: () => driver,
      driverAuthDir: "/qa/driver",
      replaceDriver: async () => {},
      runtimeEnv,
      sutAccountId: "sut",
      scenario: implementation,
      gateway: makeGateway(async (method) => {
        if (method === "channels.status") {
          return { channelAccounts: { whatsapp: [readyAccount("sut", startedAt - 30_000)] } };
        }
        throw new Error(`unexpected Gateway method: ${method}`);
      }),
    }).finally(() => {
      settled = true;
    });
    const outcome =
      fault === "none"
        ? expect(result).resolves.toHaveProperty("details")
        : expect(result).rejects.toThrow("unexpected WhatsApp reply observed in quiet scenario");
    await vi.advanceTimersByTimeAsync(quietMs - 1);
    expect(settled, "must observe the complete quiet window").toBe(false);
    if (fault !== "none") {
      // WA4 rejects even unrelated replies; mention gating retains its marker filter.
      messages.push({
        kind: "text",
        fromJid: targetJid,
        ...(fault === "unknown sender" ? {} : { fromPhoneE164: runtimeEnv.sutPhoneE164 }),
        observedAt: new Date().toISOString(),
        text:
          scenarioId === "whatsapp-mention-gating"
            ? (run.quietInput ?? run.input)
            : "unexpected reply",
      });
    }
    await vi.advanceTimersByTimeAsync(1);
    await outcome;
    expect(sends).toEqual(
      scenarioId === "whatsapp-mention-gating" && fault === "none" ? [0, 5_000] : [0],
    );
    expect(vi.getTimerCount()).toBe(0);
  },
);

function prepareConfig(scenarioId: string, call: Parameters<typeof makeGateway>[0]) {
  const definition = readQaScenarioById(scenarioId);
  return environment(
    () => {
      throw new Error("Preparation must not use driver");
    },
    "work",
    { ...runtimeEnv, groupJid: undefined },
  ).prepareFlow({
    config: definition.execution.config ?? {},
    gateway: makeGateway(call),
    outputDir: "/qa/output",
    scenarioId,
    scenarioTitle: definition.title,
    timeoutMs: 60_000,
    waitForConfigRestartSettle: vi.fn(),
  });
}

function reactionMessages(enabled: boolean) {
  return {
    ackReaction: enabled ? "👀" : "💬",
    ackReactionScope: enabled ? "direct" : "group-mentions",
    statusReactions: { enabled },
  } satisfies OpenClawConfig["messages"];
}

it.each([
  { id: "whatsapp-agent-message-action-react", statusReactions: false },
  { id: "whatsapp-status-reaction-lifecycle", statusReactions: true },
])("configures $id through the current WhatsApp schema", async ({ id, statusReactions }) => {
  vi.useFakeTimers();
  const connectedAt = Date.now();
  const baseMessages = reactionMessages(false);
  const gatewayCall = vi.fn(async (method: string, _params?: unknown) => {
    if (method === "config.get") {
      return { config: { messages: baseMessages }, hash: "config-hash" };
    }
    if (method === "config.patch") {
      const { raw, replacePaths } = _params as { raw: string; replacePaths: string[] };
      const cfg = JSON.parse(raw) as OpenClawConfig;
      const validation = validateJsonSchemaValue({
        schema: WhatsAppChannelConfigSchema.schema,
        value: cfg.channels?.whatsapp,
        applyDefaults: true,
      });
      expect(validation.ok, JSON.stringify(validation)).toBe(true);
      expect(cfg.messages).toEqual(reactionMessages(statusReactions));
      expect(replacePaths).toContain("channels.whatsapp.accounts.work.allowFrom");
      expect(replacePaths).not.toContain("channels.whatsapp.accounts.sut.allowFrom");
      return { noop: true };
    }
    if (method === "channels.status") {
      return { channelAccounts: { whatsapp: [readyAccount("work", connectedAt)] } };
    }
    throw new Error(`unexpected gateway method: ${method}`);
  });
  const prepared = prepareConfig(id, gatewayCall);
  await vi.dynamicImportSettled();
  await vi.advanceTimersByTimeAsync(20_000);
  await prepared;

  expect(gatewayCall.mock.calls.map(([method]) => method)).toContain("config.patch");
});

it("leaves generic declarative flows to their own config preparation", async () => {
  const gatewayCall = vi.fn();
  const id = "whatsapp-access-control-dm-disabled";
  const prepared = await prepareConfig(id, gatewayCall);
  expect(prepared.whatsappScenarioContext.scenario.id).toBe(id);
  expect(gatewayCall).not.toHaveBeenCalled();
});
