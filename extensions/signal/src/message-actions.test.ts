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
type ActionOverrides = Partial<Omit<ActionContext, "params">>;
function react(params: ActionContext["params"], overrides: ActionOverrides = {}) {
  return signalMessageActions.handleAction?.({
    channel: "signal",
    action: "react",
    cfg: DEFAULT_CFG,
    ...overrides,
    params: { to: "+15559999999", messageId: "123", emoji: "✅", ...params },
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
      toolContext,
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
  });

  it("keeps inherited Signal reply ids in the durable delivery context", async () => {
    expect(await prepareReply("implicit")).toEqual({ text: "reply" });
  });

  it("preserves explicit Signal replies when implicit replies are suppressed", async () => {
    const prepared = await prepareReply("explicit", {
      currentMessageId: "1700000000001",
      replyToMode: "off",
    });
    expect(prepared).toEqual({ text: "reply", replyToId: "1700000000001" });
  });

  it("blocks reactions when the action gate is disabled", async () => {
    await expect(react({ to: "+15550001111" }, { cfg: disabledCfg })).rejects.toThrow(
      /actions\.reactions/,
    );
  });

  it("maps reaction targets into sendReactionSignal calls", async () => {
    type Options = Omit<Parameters<typeof sendReactionsModule.sendReactionSignal>[3], "cfg">;
    const work = { cfg: overrideCfg, accountId: "work" };
    const group = { groupId: "group-id", targetAuthor: `uuid:${uuid}` };
    const current = { toolContext: { currentMessageId: "1737630212345" } };
    const cases: Array<[ActionContext["params"], string, ActionOverrides?, Options?, number?]> = [
      [{ to: "+15550001111" }, "+15550001111", work, { accountId: "work" }],
      [{ to: ` SiGnAl: UuId:${uuid.toUpperCase()} ` }, uuid.toUpperCase()],
      [{ to: "signal:group:group-id", targetAuthor: group.targetAuthor }, "", {}, group],
      [{ to: "+15559999999", messageId: undefined }, "+15559999999", current, {}, 1737630212345],
    ];
    for (const [params, recipient, context, options, timestamp = 123] of cases) {
      sendReactionSignalMock.mockClear();
      await react({ emoji: "🔥", ...params }, context);
      expect(sendReactionSignalMock, String(params.to)).toHaveBeenCalledWith(
        recipient,
        timestamp,
        "🔥",
        {
          cfg: context?.cfg ?? DEFAULT_CFG,
          accountId: "default",
          groupId: undefined,
          targetAuthor: undefined,
          targetAuthorUuid: undefined,
          ...options,
        },
      );
    }
  });

  it.each([false, true])(
    "binds provider reactions to the canonical target (remove=%s)",
    async (remove) => {
      const result = await react({
        recipient: "+15558888888",
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
    ["work", { enabled: false, account: "+15550002222" }, /account "work" is disabled/],
    ["default", undefined, /account "default" is not configured/],
  ] as const)(
    "rejects unavailable %s accounts before provider dispatch",
    async (accountId, account, error) => {
      const cfg = {
        channels: {
          signal: account ? { account: "+15550001111", accounts: { [accountId]: account } } : {},
        },
      };
      await expect(react({}, { cfg, accountId })).rejects.toThrow(error);
      expect(sendReactionSignalMock).not.toHaveBeenCalled();
      expect(removeReactionSignalMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{ messageId: undefined }, /messageId.*required/],
    [{ messageId: "123abc" }, /Invalid messageId/],
    [{ emoji: undefined, remove: false }, /Emoji required to add reaction/],
    [{ emoji: undefined, remove: true }, /Emoji required to remove reaction/],
    [{ to: "signal:group:group-id" }, /targetAuthor/],
    [{ to: undefined, recipient: "+15559999999" }, /recipient.*required/],
  ])("rejects invalid reaction inputs %j before dispatch", async (params, error) => {
    await expect(react(params)).rejects.toThrow(error);
    expect(sendReactionSignalMock).not.toHaveBeenCalled();
    expect(removeReactionSignalMock).not.toHaveBeenCalled();
  });
});
