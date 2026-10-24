import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";

type ReportChannelRoomJoin =
  typeof import("openclaw/plugin-sdk/channel-join-intro-runtime").reportChannelRoomJoin;

const { reportChannelRoomJoinMock } = vi.hoisted(() => ({
  reportChannelRoomJoinMock: vi.fn<ReportChannelRoomJoin>(async () => ({ kind: "posted" })),
}));

vi.mock("openclaw/plugin-sdk/channel-join-intro-runtime", () => ({
  reportChannelRoomJoin: reportChannelRoomJoinMock,
}));

const { getChatSpy, getLoadConfigMock, getOnHandler } =
  await import("./bot.create-telegram-bot.test-harness.js");
const { createTelegramBotCore } = await import("./bot-core.js");
const { runWithTelegramSpooledReplayUpdate, getTelegramSpooledReplayDeferredParticipant } =
  await import("./bot-processing-outcome.js");

const chatId = -1001234567890;
const room = { id: chatId, type: "supergroup", title: "Incident Response" };

function createMembershipContext(newStatus: "left" | "member" = "member") {
  const membership = {
    chat: room,
    from: { id: 12345, is_bot: false, first_name: "Sam", last_name: "Rivera" },
    date: 1736380800,
    old_chat_member: { status: "left", user: telegramBotInfoForTest },
    new_chat_member: { status: newStatus, user: telegramBotInfoForTest },
  };
  return {
    update: { update_id: 900, my_chat_member: membership },
    myChatMember: membership,
    me: telegramBotInfoForTest,
  };
}

type TelegramConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["telegram"]>;

async function registerJoinHandler(config: TelegramConfig = { groupPolicy: "open" }) {
  getLoadConfigMock().mockReturnValue({ channels: { telegram: config } });
  await createTelegramBotCore({ token: "tok", botInfo: telegramBotInfoForTest });
  return getOnHandler("my_chat_member");
}

async function replayJoin(
  options: Partial<NonNullable<Parameters<typeof runWithTelegramSpooledReplayUpdate>[2]>> = {},
) {
  const handler = await registerJoinHandler();
  const context = createMembershipContext();
  return runWithTelegramSpooledReplayUpdate(context.update, () => handler(context), {
    abortSignal: new AbortController().signal,
    onAdopted: vi.fn(),
    onDeferred: vi.fn(),
    onAbandoned: vi.fn(),
    ...options,
  });
}

describe("Telegram group join introductions", () => {
  beforeEach(() => reportChannelRoomJoinMock.mockClear());

  it("reports the bot's native group join with metadata-only room context", async () => {
    const config: TelegramConfig = { groupPolicy: "open", groupAllowFrom: ["99999"] };
    getChatSpy.mockResolvedValue({
      ...room,
      description: "Coordinate production incidents",
      pinned_message: { text: "Start with the incident checklist" },
    });
    const handler = await registerJoinHandler(config);
    await handler(createMembershipContext());
    expect(reportChannelRoomJoinMock).toHaveBeenCalledTimes(1);
    const params = reportChannelRoomJoinMock.mock.calls[0]?.[0];
    expect(params).toMatchObject({
      cfg: { channels: { telegram: config } },
      channel: "telegram",
      accountId: "default",
      conversationId: String(chatId),
      deliverTo: String(chatId),
      inviterLabel: "Sam Rivera",
      roomAllowed: true,
      route: { agentId: "main" },
    });
    await expect(params?.resolveRoomContext({ messageLimit: 30 })).resolves.toEqual({
      title: "Incident Response",
      purpose: "Coordinate production incidents",
      pinned: "Start with the incident checklist",
      historyUnavailable: true,
    });
    expect(getChatSpy).toHaveBeenCalledWith(chatId);
  });

  it("ignores a departure", async () => {
    const handler = await registerJoinHandler();
    await handler(createMembershipContext("left"));
    expect(reportChannelRoomJoinMock).not.toHaveBeenCalled();
    expect(getChatSpy).not.toHaveBeenCalled();
  });

  it.each<[string, TelegramConfig]>([
    ["disabled policy", { groupPolicy: "disabled" }],
    ["disabled room", { groupPolicy: "open", groups: { [chatId]: { enabled: false } } }],
    [
      "allowlist miss",
      { groupPolicy: "allowlist", groups: { "-1009999999999": { enabled: true } } },
    ],
  ])("reports roomAllowed=false for %s", async (_name, config) => {
    const handler = await registerJoinHandler(config);
    await handler(createMembershipContext());
    expect(reportChannelRoomJoinMock).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: String(chatId), roomAllowed: false }),
    );
    expect(getChatSpy).not.toHaveBeenCalled();
  });

  it("does not start an introduction after its ingress owner was aborted", async () => {
    const frame = await replayJoin({
      abortSignal: AbortSignal.abort(new Error("account stopped")),
    });
    expect(reportChannelRoomJoinMock).not.toHaveBeenCalled();
    await expect(frame.deferredWork?.task).resolves.toMatchObject({ kind: "failed-retryable" });
  });

  it("retains an accepted introduction through owner abort while the shared owner is pending", async () => {
    const accepted = createDeferred<void>();
    const commit = createDeferred<void>();
    const abort = new AbortController();
    const finalizing = vi.fn();
    let participant: ReturnType<typeof getTelegramSpooledReplayDeferredParticipant>;
    reportChannelRoomJoinMock.mockImplementationOnce(async () => {
      participant = getTelegramSpooledReplayDeferredParticipant();
      accepted.resolve();
      await commit.promise;
      return { kind: "posted" };
    });
    const frame = replayJoin({ abortSignal: abort.signal, onAdoptionFinalizing: finalizing });
    try {
      await accepted.promise;
      expect(finalizing).toHaveBeenCalledOnce();
      expect(participant).toBeDefined();
      abort.abort(new Error("account stopped"));
      expect(participant?.isSettled()).toBe(false);
    } finally {
      commit.resolve();
      await frame;
    }
    await expect(participant?.task).resolves.toEqual({ kind: "completed" });
  });

  it("settles the introduction hold when the shared owner throws unexpectedly", async () => {
    const error = new Error("introduction owner failed");
    let participant: ReturnType<typeof getTelegramSpooledReplayDeferredParticipant>;
    reportChannelRoomJoinMock.mockImplementationOnce(async () => {
      participant = getTelegramSpooledReplayDeferredParticipant();
      throw error;
    });
    await expect(replayJoin()).rejects.toBe(error);
    await expect(participant?.task).resolves.toEqual({ kind: "failed-retryable", error });
  });
});
