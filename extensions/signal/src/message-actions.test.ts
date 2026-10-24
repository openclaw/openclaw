import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendReactionsModule = await import("./send-reactions.js");
const sendReactionSignalMock = vi
  .spyOn(sendReactionsModule, "sendReactionSignal")
  .mockResolvedValue({ ok: true });
const removeReactionSignalMock = vi
  .spyOn(sendReactionsModule, "removeReactionSignal")
  .mockResolvedValue({ ok: true });
const { signalMessageActions } = await import("./message-actions.js");

const DEFAULT_CFG: OpenClawConfig = { channels: { signal: { account: "+15550001111" } } };
const uuid = "123e4567-e89b-12d3-a456-426614174000";
const disabledCfg = {
  channels: { signal: { account: "+15550001111", actions: { reactions: false } } },
};
type ActionContext = Parameters<NonNullable<typeof signalMessageActions.handleAction>>[0];
function react(
  params: ActionContext["params"],
  overrides: Partial<Omit<ActionContext, "params">> = {},
) {
  return signalMessageActions.handleAction?.({
    channel: "signal",
    action: "react",
    cfg: DEFAULT_CFG,
    ...overrides,
    params,
  });
}

type PrepareContext = Parameters<NonNullable<typeof signalMessageActions.prepareSendPayload>>[0];
function prepareReply(
  replyToIdSource: PrepareContext["replyToIdSource"],
  toolContext?: ActionContext["toolContext"],
) {
  return signalMessageActions.prepareSendPayload?.({
    ctx: {
      channel: "signal",
      action: "send",
      cfg: {},
      params: { replyTo: "1700000000001" },
      ...(toolContext ? { toolContext } : {}),
    },
    to: "+15550001111",
    payload: { text: "reply" },
    replyToId: "1700000000001",
    replyToIdSource,
  });
}

const overrideCfg: OpenClawConfig = {
  channels: {
    signal: {
      account: "+15550002222",
      actions: { reactions: false },
      accounts: { work: { account: "+15550001111", actions: { reactions: true } } },
    },
  },
};

describe("signalMessageActions", () => {
  beforeEach(() => {
    sendReactionSignalMock.mockClear();
    removeReactionSignalMock.mockClear();
  });

  it.each([
    ["unconfigured", {}, undefined, []],
    ["reactions disabled", disabledCfg, undefined, ["send"]],
    ["any enabled account", overrideCfg, undefined, ["send", "react"]],
    ["default account", overrideCfg, "default", ["send"]],
    ["work account", overrideCfg, "work", ["send", "react"]],
  ] as const)("discovers actions for %s", (_name, cfg, accountId, actions) => {
    expect(
      signalMessageActions.describeMessageTool?.({ cfg, accountId })?.actions ?? [],
    ).toStrictEqual(actions);
  });

  it("supports only reactions for plugin dispatch", () => {
    expect(signalMessageActions.supportsAction?.({ action: "send" })).toBe(false);
    expect(signalMessageActions.supportsAction?.({ action: "react" })).toBe(true);
    expect(signalMessageActions.supportsAction?.({ action: "delete" })).toBe(false);
    expect(signalMessageActions.supportsAction?.({ action: "pin" })).toBe(false);
  });

  it("keeps inherited Signal reply ids in the durable delivery context", async () => {
    expect(await prepareReply("implicit")).toEqual({ text: "reply" });
  });

  it("preserves explicit Signal replies when implicit replies are suppressed", async () => {
    for (const replyToMode of ["off", "batched"] as const) {
      const prepared = await prepareReply("explicit", {
        currentMessageId: "1700000000001",
        replyToMode,
      });
      expect(prepared, replyToMode).toEqual({ text: "reply", replyToId: "1700000000001" });
    }
  });

  it("blocks reactions when the action gate is disabled", async () => {
    await expect(
      react({ to: "+15550001111", messageId: "123", emoji: "✅" }, { cfg: disabledCfg }),
    ).rejects.toThrow(/actions\.reactions/);
  });

  it("maps reaction targets into sendReactionSignal calls", async () => {
    const cases: Array<{
      params: ActionContext["params"];
      context?: Partial<Omit<ActionContext, "params">>;
      recipient: string;
      timestamp?: number;
      options?: Omit<Parameters<typeof sendReactionsModule.sendReactionSignal>[3], "cfg">;
    }> = [
      {
        context: { cfg: overrideCfg, accountId: "work" },
        params: { to: "+15550001111" },
        recipient: "+15550001111",
        options: { accountId: "work" },
      },
      {
        params: { to: `uuid:${uuid}` },
        recipient: uuid,
      },
      {
        params: { to: ` SiGnAl: UuId:${uuid.toUpperCase()} ` },
        recipient: uuid.toUpperCase(),
      },
      {
        params: { to: "signal:group:group-id", targetAuthor: `uuid:${uuid}` },
        recipient: "",
        options: { groupId: "group-id", targetAuthor: `uuid:${uuid}` },
      },
      {
        params: { to: "+15559999999", messageId: undefined },
        recipient: "+15559999999",
        context: { toolContext: { currentMessageId: "1737630212345" } },
        timestamp: 1737630212345,
      },
    ];
    for (const testCase of cases) {
      sendReactionSignalMock.mockClear();
      await react({ messageId: "123", emoji: "🔥", ...testCase.params }, testCase.context);
      expect(sendReactionSignalMock, String(testCase.params.to)).toHaveBeenCalledWith(
        testCase.recipient,
        testCase.timestamp ?? 123,
        "🔥",
        {
          cfg: testCase.context?.cfg ?? DEFAULT_CFG,
          accountId: "default",
          groupId: undefined,
          targetAuthor: undefined,
          targetAuthorUuid: undefined,
          ...testCase.options,
        },
      );
    }
  });

  it.each([false, true])(
    "binds provider reactions to the canonical target (remove=%s)",
    async (remove) => {
      const result = await react({
        to: "+15559999999",
        recipient: "+15558888888",
        messageId: "123",
        emoji: "✅",
        ...(remove ? { remove } : {}),
      });
      expect(remove ? removeReactionSignalMock : sendReactionSignalMock).toHaveBeenCalledWith(
        "+15559999999",
        123,
        "✅",
        expect.objectContaining({ accountId: "default" }),
      );
      expect(result?.details).toEqual({ ok: true, [remove ? "removed" : "added"]: "✅" });
    },
  );

  it.each([
    {
      name: "disabled",
      cfg: {
        channels: {
          signal: {
            account: "+15550001111",
            accounts: { work: { enabled: false, account: "+15550002222" } },
          },
        },
      },
      accountId: "work",
      error: /account "work" is disabled/,
    },
    {
      name: "unconfigured",
      cfg: { channels: { signal: {} } },
      accountId: "default",
      error: /account "default" is not configured/,
    },
  ])("rejects $name accounts before provider dispatch", async ({ cfg, accountId, error }) => {
    await expect(
      react({ to: "+15559999999", messageId: "123", emoji: "✅" }, { cfg, accountId }),
    ).rejects.toThrow(error);
    expect(sendReactionSignalMock).not.toHaveBeenCalled();
    expect(removeReactionSignalMock).not.toHaveBeenCalled();
  });

  it("rejects invalid reaction inputs before dispatch", async () => {
    await expect(react({ to: "+15559999999", emoji: "✅" })).rejects.toThrow(/messageId.*required/);
    await expect(react({ to: "+15559999999", messageId: "123abc", emoji: "✅" })).rejects.toThrow(
      /Invalid messageId/,
    );
    expect(sendReactionSignalMock).not.toHaveBeenCalled();
    for (const remove of [false, true]) {
      await expect(react({ to: "+15559999999", messageId: "123", remove })).rejects.toThrow(
        `Emoji required to ${remove ? "remove" : "add"} reaction.`,
      );
    }
    await expect(
      react({ to: "signal:group:group-id", messageId: "123", emoji: "✅" }),
    ).rejects.toThrow(/targetAuthor/);
    await expect(
      react({ recipient: "+15559999999", messageId: "123", emoji: "✅" }),
    ).rejects.toThrow(/recipient.*required/);
    expect(sendReactionSignalMock).not.toHaveBeenCalled();
  });
});
