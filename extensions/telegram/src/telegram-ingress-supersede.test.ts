import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  addChannelAllowFromStoreEntry,
  closeOpenClawStateDatabaseForTest,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setTelegramRuntime } from "./runtime.js";

let openClawState: OpenClawTestState | undefined;

beforeEach(() => setTelegramRuntime(createPluginRuntimeMock()));

afterEach(async () => {
  clearRuntimeConfigSnapshot();
  closeOpenClawStateDatabaseForTest();
  await openClawState?.cleanup();
  openClawState = undefined;
});
import type { TelegramSpooledUpdatePayload } from "./telegram-ingress-spool.payload.js";
import { isTelegramSpooledUpdateSenderAuthorized } from "./telegram-ingress-supersede-auth.js";
import { createShouldSupersedeTelegramSpooledPending as createSupersedePredicate } from "./telegram-ingress-supersede.js";

function supersedeFor(auth: Parameters<typeof isTelegramSpooledUpdateSenderAuthorized>[1]) {
  const predicate = createSupersedePredicate({ ...auth, getConfig: () => auth.cfg });
  return async (...events: Parameters<typeof predicate>) => {
    const decision = await predicate(...events);
    return typeof decision === "function" ? decision() : decision;
  };
}

const OWNER_ID = "111";
const STRANGER_ID = "999";

function authFor(
  telegram: NonNullable<NonNullable<OpenClawConfig["channels"]>["telegram"]>,
): Parameters<typeof isTelegramSpooledUpdateSenderAuthorized>[1] {
  return { cfg: { channels: { telegram } }, accountId: "default" };
}

function messageUpdate(params: {
  updateId?: number;
  text?: string;
  senderId?: string;
  chatId?: number;
  chatType?: string;
  messageThreadId?: number;
  isTopicMessage?: boolean;
  isForum?: boolean;
  isDirectMessages?: boolean;
  directMessagesTopicId?: number;
  entities?: Array<{ type: string; offset: number; length: number }>;
}) {
  const { updateId = 2, text = "stop", senderId = OWNER_ID } = params;
  return {
    update_id: updateId,
    message: {
      text,
      from: { id: Number(senderId) },
      chat: {
        id: params.chatId ?? Number(senderId),
        type: params.chatType ?? "private",
        ...(params.isForum !== undefined ? { is_forum: params.isForum } : {}),
        ...(params.isDirectMessages !== undefined
          ? { is_direct_messages: params.isDirectMessages }
          : {}),
      },
      ...(params.messageThreadId !== undefined
        ? { message_thread_id: params.messageThreadId }
        : {}),
      ...(params.isTopicMessage !== undefined ? { is_topic_message: params.isTopicMessage } : {}),
      ...(params.directMessagesTopicId !== undefined
        ? { direct_messages_topic: { topic_id: params.directMessagesTopicId } }
        : {}),
      ...(params.entities ? { entities: params.entities } : {}),
    },
  };
}

function record(id: string, update: unknown) {
  return {
    id,
    channelId: "telegram",
    accountId: "default",
    queueName: "q",
    payload: {
      version: 1,
      updateId: Number(id),
      receivedAt: Number(id),
      update,
    } satisfies TelegramSpooledUpdatePayload,
    receivedAt: Number(id),
    updatedAt: Number(id),
    attempts: 0,
  };
}

function claim(id: string, update: unknown) {
  return {
    ...record(id, update),
    claim: { token: "test-auth-token", ownerId: "1:1:x", claimedAt: 1 },
  };
}

type MessageOptions = Parameters<typeof messageUpdate>[0];
function candidate(text: string, senderId = OWNER_ID, options: MessageOptions = {}) {
  const update = messageUpdate({ text, senderId, ...options });
  return record(String(update.update_id), update);
}
function pending(senderId = OWNER_ID, options: MessageOptions = {}) {
  return claim("1", messageUpdate({ updateId: 1, text: "prior", senderId, ...options }));
}
const group = { chatId: -1001, chatType: "supergroup" };
const topic = { ...group, messageThreadId: 10, isTopicMessage: true, isForum: true };

describe("telegram ingress supersede policy", () => {
  const auth = authFor({ allowFrom: [OWNER_ID], dmPolicy: "allowlist" });
  const shouldSupersede = supersedeFor(auth);

  it("follows account runtime policy and expires prepared decisions", async () => {
    const policy = (allowFrom: string[]): OpenClawConfig => ({
      channels: {
        telegram: { accounts: { default: { dmPolicy: "allowlist", allowFrom } } },
      },
    });
    setRuntimeConfigSnapshot(policy([]));
    const predicate = createSupersedePredicate({
      getConfig: getRuntimeConfig,
      accountId: "default",
    });
    const next = candidate("stop");
    const prior = pending();
    expect(await predicate(next, prior)).toBe(false);

    setRuntimeConfigSnapshot(policy([OWNER_ID]));
    const decision = await predicate(next, prior);
    expect(typeof decision).toBe("function");
    if (typeof decision !== "function") {
      throw new Error("expected a prepared policy guard");
    }
    expect(decision()).toBe(true);
    setRuntimeConfigSnapshot(policy([]));
    expect(decision()).toBe(false);
    expect(await predicate(next, prior)).toBe(false);
  });

  it("honors disabled topic group policy for an allowlisted sender", async () => {
    const groupConfig = {
      allowFrom: [OWNER_ID],
      topics: { "10": { groupPolicy: "disabled" as const } },
    };
    const account = {
      groupAllowFrom: [OWNER_ID],
      groupPolicy: "open" as const,
      groups: { "-1001": groupConfig },
    };
    const topicAuth = authFor({ accounts: { default: account } });
    expect(
      await isTelegramSpooledUpdateSenderAuthorized(
        messageUpdate({
          updateId: 1,
          text: "hello",
          senderId: OWNER_ID,
          ...topic,
        }),
        topicAuth,
      ),
    ).toBe(false);
  });

  it("gates command supersede on authorized sender", async () => {
    const authorized = await shouldSupersede(candidate("/new"), pending());
    const unauthorized = await shouldSupersede(
      candidate("/new", STRANGER_ID, { ...group, updateId: 3 }),
      pending(OWNER_ID, group),
    );
    expect(authorized).toBe(true);
    expect(unauthorized).toBe(false);
  });

  it.each([
    { senderId: OWNER_ID, messageSenderId: STRANGER_ID, expected: true },
    { senderId: STRANGER_ID, messageSenderId: OWNER_ID, expected: false },
  ])("authorizes callback sender $senderId independently of its message author", async (entry) => {
    const update = {
      update_id: 2,
      callback_query: {
        data: "/new",
        from: { id: Number(entry.senderId) },
        message: messageUpdate({
          text: "controls",
          senderId: entry.messageSenderId,
        }).message,
      },
    };
    expect(await shouldSupersede(record("2", update), pending())).toBe(entry.expected);
  });

  it("gates ambient room-event supersede on authorized sender", async () => {
    expect(
      await shouldSupersede(candidate("hi"), claim("1", { update_id: 1, message_reaction: {} })),
    ).toBe(true);
    expect(
      await shouldSupersede(
        candidate("hi", STRANGER_ID, { updateId: 3 }),
        claim("1", { update_id: 1, message_reaction: {} }),
      ),
    ).toBe(false);
  });

  it.each([
    ["/deploy", false],
    ["/stop", true],
    ["/reset", true],
  ])("only cancellation commands supersede pending input: %s", async (text, expected) => {
    const predicate = supersedeFor({
      ...auth,
      botUsername: "mybot",
    });
    for (const target of ["", "@mybot", "@otherbot"]) {
      const commandText = `${text}${target}`;
      for (const entities of [
        undefined,
        [{ type: "bot_command", offset: 0, length: commandText.length }],
      ]) {
        expect(
          await predicate(
            candidate(commandText, OWNER_ID, { entities }),
            pending(OWNER_ID, { text: "prior question" }),
          ),
        ).toBe(expected && target !== "@otherbot");
      }
    }
  });

  it("keeps identityless targeted aborts pessimistic", async () => {
    const text = "/stop@OtherBot!";
    const entityText = "/stop@OtherBot";
    const update = candidate(text, OWNER_ID, {
      entities: [{ type: "bot_command", offset: 0, length: entityText.length }],
    });

    expect(await shouldSupersede(update, pending())).toBe(true);
  });

  it("does not supersede when a bot_command entity appears inside ordinary text", async () => {
    const shouldSupersedeOurBot = supersedeFor({
      ...auth,
      botUsername: "mybot",
    });
    const commandText = "/deploy@mybot";
    const ordinaryText = `Please run ${commandText} after this finishes`;
    const entities = [
      {
        type: "bot_command",
        offset: ordinaryText.indexOf(commandText),
        length: commandText.length,
      },
    ];
    const ordinaryMessage = messageUpdate({ text: ordinaryText, entities });
    const ordinaryCaption = {
      update_id: 3,
      message: {
        caption: ordinaryText,
        caption_entities: entities,
        from: { id: Number(OWNER_ID) },
        chat: { id: Number(OWNER_ID), type: "private" },
      },
    };

    for (const update of [ordinaryMessage, ordinaryCaption]) {
      expect(await shouldSupersedeOurBot(record(String(update.update_id), update), pending())).toBe(
        false,
      );
    }
  });

  it("rejects supersede when topic allowFrom excludes the sender despite account allowFrom *", async () => {
    const topicRestrictedAuth = authFor({
      allowFrom: ["*"],
      groupAllowFrom: ["*"],
      groupPolicy: "allowlist",
      groups: { "-1001": { allowFrom: ["*"], topics: { "10": { allowFrom: [OWNER_ID] } } } },
    });
    const shouldSupersedeTopic = supersedeFor(topicRestrictedAuth);
    expect(
      await shouldSupersedeTopic(candidate("stop", STRANGER_ID, topic), pending(OWNER_ID, topic)),
    ).toBe(false);
    expect(
      await shouldSupersedeTopic(
        candidate("stop", OWNER_ID, { ...topic, updateId: 3 }),
        pending(OWNER_ID, topic),
      ),
    ).toBe(true);
  });

  it("uses channel-DM topic authorization to deny a sender allowed by the base chat", async () => {
    const channelDmAuth = authFor({
      groupPolicy: "allowlist",
      groupAllowFrom: [OWNER_ID],
      groups: {
        "-1001": {
          allowFrom: [OWNER_ID],
          topics: { "77": { allowFrom: [STRANGER_ID] } },
        },
      },
    });
    const update = messageUpdate({
      ...group,
      isDirectMessages: true,
      directMessagesTopicId: 77,
      messageThreadId: 999,
    });

    expect(await supersedeFor(channelDmAuth)(record("2", update), pending())).toBe(false);
  });

  it("authorizes paired DM senders via the pairing store under dmPolicy pairing", async () => {
    const pairedId = "424242";
    openClawState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-supersede-store-",
    });
    await addChannelAllowFromStoreEntry({
      channel: "telegram",
      entry: pairedId,
      accountId: "default",
    });
    const pairingAuth = authFor({ dmPolicy: "pairing" });
    const shouldSupersedePaired = supersedeFor(pairingAuth);

    expect(await shouldSupersedePaired(candidate("stop", pairedId), pending(pairedId))).toBe(true);

    expect(
      await shouldSupersedePaired(
        candidate("stop", STRANGER_ID, { updateId: 3 }),
        pending(pairedId),
      ),
    ).toBe(false);
  });

  it("authorizes commands.ownerAllowFrom senders for supersede", async () => {
    const ownerId = "777001";
    const ownerAuth = authFor({ dmPolicy: "pairing" });
    ownerAuth.cfg.commands = { ownerAllowFrom: [ownerId] };
    const shouldSupersedeOwner = supersedeFor(ownerAuth);

    expect(await shouldSupersedeOwner(candidate("/stop", ownerId), pending(ownerId))).toBe(true);
  });
});
