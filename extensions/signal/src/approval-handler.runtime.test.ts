import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMocks = vi.hoisted(() => ({ sendTypingSignal: vi.fn(), sendMessageSignal: vi.fn() }));
// mock-isolation: Native approval delivery is observed through synthetic transport calls only.
vi.mock("./send.js", () => sendMocks);
const { transport } = (await import("./approval-handler.runtime.js")).signalApprovalNativeRuntime;
const to = "+15551230000";
const context = { baseUrl: "http://127.0.0.1:18080", account: "+15550001111" };
const manualText =
  "Exec approval required\nID: exec-1\n\nReply with: /approve exec-1 allow-once|deny";
const reactionHint = "React with:\n\n👍 Allow Once\n👎 Deny";
const reactionText = manualText.replace("Reply with:", `${reactionHint}\n\nReply with:`);
type SignalConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["signal"]>;

function prepare(
  cfg: OpenClawConfig | undefined,
  target: string,
  accountId?: string,
  bound = true,
) {
  return transport.prepareTarget({
    cfg,
    plannedTarget: { target: { to: target } },
    accountId,
    context: bound ? context : { baseUrl: context.baseUrl },
  } as never);
}

function deliver(
  cfg: OpenClawConfig,
  prepared: Awaited<ReturnType<typeof prepare>>,
  text = "approval",
) {
  return transport.deliverPending({
    cfg,
    preparedTarget: prepared!.target,
    pendingPayload: {
      manualFallbackPayload: { text },
      reactionPayload: {
        text: text === manualText ? reactionText : text,
        allowedDecisions: ["allow-once", "deny"],
        reactionBindings: [],
      },
    },
  } as never);
}

describe("Signal approval native runtime", () => {
  beforeEach(() => {
    sendMocks.sendTypingSignal.mockReset().mockResolvedValue(true);
    sendMocks.sendMessageSignal.mockReset().mockResolvedValue({
      messageId: "1700000000000",
      timestamp: 1700000000000,
      receipt: { parts: [] },
    });
  });

  it.each<[SignalConfig, string, string | undefined, string]>([
    [{ allowFrom: [to], aliases: { me: to } }, "me", "default", "default"],
    [
      { defaultAccount: "work", accounts: { work: { aliases: { ops: to } } } },
      "ops",
      undefined,
      "work",
    ],
  ])(
    "resolves aliases for %s before delivering approval prompts",
    async (signal, alias, explicit, accountId) => {
      const cfg = { channels: { signal } };
      const prepared = await prepare(cfg, `signal:${alias}`, explicit);
      const options = { cfg, accountId, ...context };
      expect(prepared?.target).toMatchObject({ to, accountId, ...context });
      expect(await deliver(cfg, prepared)).toMatchObject({ to, conversationKey: to });
      expect(sendMocks.sendTypingSignal).toHaveBeenCalledWith(to, options);
      expect(sendMocks.sendMessageSignal).toHaveBeenCalledWith(to, "approval", {
        ...options,
        textMode: "markdown",
      });
    },
  );

  it("only renders reaction hints when the Signal target author can be bound", async () => {
    const cfg = { channels: { signal: { allowFrom: [to] } } };
    await deliver(cfg, await prepare(undefined, to, "default", false), manualText);
    expect(sendMocks.sendMessageSignal).toHaveBeenLastCalledWith(
      to,
      expect.not.stringContaining("React with:"),
      expect.any(Object),
    );
    await deliver(cfg, await prepare(undefined, to, "default"), manualText);
    expect(sendMocks.sendMessageSignal).toHaveBeenLastCalledWith(
      to,
      expect.stringContaining(reactionHint),
      expect.any(Object),
    );
  });
});
