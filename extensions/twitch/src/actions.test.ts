import { describe, expect, it, vi } from "vitest";
import { twitchMessageActions } from "./actions.js";

vi.mock("./config.js", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  getAccountConfig: vi.fn(),
}));

vi.mock("./outbound.js", () => ({
  twitchOutbound: {
    sendText: vi.fn(),
  },
}));

describe("twitchMessageActions", () => {
  it("lists supported actions", () => {
    expect(twitchMessageActions.listActions()).toEqual(["send"]);
    expect(twitchMessageActions.supportsAction({ action: "send" })).toBe(true);
    expect(twitchMessageActions.supportsAction({ action: "unknown" })).toBe(false);
  });

  it("extracts tool send params", () => {
    const parsed = twitchMessageActions.extractToolSend?.({
      args: { to: "#MyChannel", message: "  Hello Twitch  " },
    });
    expect(parsed).toEqual({ to: "#MyChannel", message: "Hello Twitch" });
  });

  it("returns null for invalid tool send args", () => {
    const parsed = twitchMessageActions.extractToolSend?.({
      args: { to: "#test" },
    });
    expect(parsed).toBeNull();
  });

  it("returns unsupported action error payload", async () => {
    const result = await twitchMessageActions.handleAction?.({
      action: "delete",
      params: {},
      cfg: {} as never,
      accountId: "default",
    } as never);

    expect(result?.details).toEqual({ ok: false, error: "Unsupported action" });
  });

  it("returns account-not-found error when account is missing", async () => {
    const { getAccountConfig } = await import("./config.js");
    vi.mocked(getAccountConfig).mockReturnValue(null);

    const result = await twitchMessageActions.handleAction?.({
      action: "send",
      params: { message: "hello" },
      cfg: { channels: { twitch: { accounts: {} } } } as never,
      accountId: "default",
    } as never);

    expect(result?.details).toEqual({ ok: false });
    const payload = JSON.parse(result?.content[0]?.text ?? "{}");
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("Account not found");
  });

  it("sends via outbound adapter with explicit target", async () => {
    const { getAccountConfig } = await import("./config.js");
    const { twitchOutbound } = await import("./outbound.js");

    vi.mocked(getAccountConfig).mockReturnValue({ channel: "#default" } as never);
    vi.mocked(twitchOutbound.sendText!).mockResolvedValue({
      channel: "twitch",
      messageId: "msg-1",
      timestamp: 123,
    });

    const result = await twitchMessageActions.handleAction?.({
      action: "send",
      params: { message: "hello", to: "#override" },
      cfg: {} as never,
      accountId: "default",
    } as never);

    expect(twitchOutbound.sendText).toHaveBeenCalledWith({
      cfg: {},
      to: "#override",
      text: "hello",
      accountId: "default",
    });
    expect(result?.details).toEqual({ ok: true, messageId: "msg-1", channel: "twitch" });
  });

  it("accepts channel alias when to is not provided", async () => {
    const { getAccountConfig } = await import("./config.js");
    const { twitchOutbound } = await import("./outbound.js");

    vi.mocked(getAccountConfig).mockReturnValue({ channel: "#default" } as never);
    vi.mocked(twitchOutbound.sendText!).mockResolvedValue({
      channel: "twitch",
      messageId: "msg-2",
      timestamp: 456,
    });

    await twitchMessageActions.handleAction?.({
      action: "send",
      params: { message: "hello", channel: "#alias" },
      cfg: {} as never,
      accountId: "default",
    } as never);

    expect(twitchOutbound.sendText).toHaveBeenCalledWith({
      cfg: {},
      to: "#alias",
      text: "hello",
      accountId: "default",
    });
  });
});