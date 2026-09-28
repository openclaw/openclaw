import { registerPluginInteractiveHandler } from "openclaw/plugin-sdk/plugin-runtime";
import {
  createMockPluginRegistry,
  createPluginRuntimeMock,
  getActivePluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import type { FeishuCardActionEvent } from "./card-action.js";
import { dispatchFeishuPluginCardAction } from "./interactive-dispatch.js";
import { setFeishuRuntime } from "./runtime.js";

const chatGet = vi.hoisted(() => vi.fn());
vi.mock("./client.js", () => ({ createFeishuClient: () => ({ im: { chat: { get: chatGet } } }) }));

describe("Feishu plugin callback admission", () => {
  let previous: ReturnType<typeof getActivePluginRegistry>;
  const handler = vi.fn<(ctx: unknown) => void>();
  const runtime = createPluginRuntimeMock();
  const cfg: ClawdbotConfig = {
    channels: {
      feishu: {
        enabled: true,
        appId: "cli_test",
        appSecret: "test-secret",
        dmPolicy: "allowlist",
        allowFrom: ["ou_allowed"],
        groupPolicy: "allowlist",
        groupAllowFrom: ["oc_allowed"],
        groupSenderAllowFrom: ["ou_allowed"],
      },
    },
  };
  const event: FeishuCardActionEvent = {
    operator: { open_id: "ou_allowed" },
    token: "test-token",
    context: { chat_id: "oc_allowed", open_message_id: "om_original" },
    action: { tag: "button", value: { oc: "ocf1", k: "button", a: "test-form:save" } },
  };
  function dispatch(candidateCfg = cfg, candidateEvent = event, data = "test-form:save") {
    vi.mocked(runtime.config.current).mockReturnValue(candidateCfg);
    return dispatchFeishuPluginCardAction({
      event: candidateEvent,
      data,
      account: resolveFeishuRuntimeAccount({ cfg: candidateCfg }),
      channelRuntime: runtime.channel,
    });
  }
  beforeEach(() => {
    setFeishuRuntime(runtime);
    previous = getActivePluginRegistry();
    setActivePluginRegistry(createMockPluginRegistry([]));
    expect(
      registerPluginInteractiveHandler("test-plugin", {
        channel: "feishu",
        namespace: "test-form",
        handler,
      }).ok,
    ).toBe(true);
    handler.mockReset();
    chatGet.mockReset().mockResolvedValue({ code: 0, data: { chat_mode: "group" } });
    vi.mocked(runtime.channel.pairing.readAllowFromStore).mockResolvedValue([]);
  });
  afterEach(() => setActivePluginRegistry(previous ?? createMockPluginRegistry([])));

  it("admits an allowed group sender", async () => {
    await expect(dispatch()).resolves.toMatchObject({ matched: true, handled: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });
  it("admits an allowed direct sender", async () => {
    chatGet.mockResolvedValue({ code: 0, data: { chat_mode: "p2p" } });
    await dispatch();
    expect(handler).toHaveBeenCalledTimes(1);
  });
  it("uses the account pairing store for direct callbacks", async () => {
    chatGet.mockResolvedValue({ code: 0, data: { chat_mode: "p2p" } });
    const pairingCfg = {
      channels: {
        feishu: { ...cfg.channels!.feishu, dmPolicy: "pairing" as const, allowFrom: [] },
      },
    };
    await expect(dispatch(pairingCfg)).rejects.toThrow("sender is not allowed");
    expect(handler).not.toHaveBeenCalled();
    vi.mocked(runtime.channel.pairing.readAllowFromStore).mockResolvedValue(["ou_allowed"]);
    await dispatch(pairingCfg);
    expect(handler).toHaveBeenCalledTimes(1);
  });
  it.each([
    { enabled: false },
    { groupPolicy: "disabled" as const },
    { groupAllowFrom: [] },
    { groupSenderAllowFrom: ["ou_other"] },
    { groups: { oc_allowed: { enabled: false } } },
    { groups: { oc_allowed: { allowFrom: ["ou_other"] } } },
  ])("rejects callbacks denied by account/group policy: %j", async (override) => {
    await expect(
      dispatch({ channels: { feishu: { ...cfg.channels!.feishu, ...override } } }),
    ).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });
  it("does not substitute DM policy for unknown chat metadata", async () => {
    chatGet.mockResolvedValue({ code: 0, data: { chat_type: "private" } });
    await expect(dispatch()).rejects.toThrow("chat type is unavailable");
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([{ enabled: false }, { groupSenderAllowFrom: ["ou_other"] }])(
    "honors revocation while chat metadata is in flight: %j",
    async (override) => {
      chatGet.mockImplementationOnce(async () => {
        vi.mocked(runtime.config.current).mockReturnValue({
          channels: { feishu: { ...cfg.channels!.feishu, ...override } },
        });
        return { code: 0, data: { chat_mode: "group" } };
      });
      await expect(dispatch()).rejects.toThrow();
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it("rejects a config replacement during pairing authorization", async () => {
    chatGet.mockResolvedValue({ code: 0, data: { chat_mode: "p2p" } });
    vi.mocked(runtime.channel.pairing.readAllowFromStore).mockImplementationOnce(async () => {
      vi.mocked(runtime.config.current).mockReturnValue({
        channels: { feishu: { ...cfg.channels!.feishu, enabled: false } },
      });
      return ["ou_allowed"];
    });
    await expect(
      dispatch({
        channels: { feishu: { ...cfg.channels!.feishu, dmPolicy: "pairing", allowFrom: [] } },
      }),
    ).rejects.toThrow("configuration changed");
    expect(handler).not.toHaveBeenCalled();
  });
  it.each([
    {},
    { chat_id: "oc_allowed", open_message_id: "card-action-c-temporary" },
    { open_message_id: "om_original" },
  ])("requires original card context: %j", async (context) => {
    await expect(dispatch(cfg, { ...event, context })).rejects.toThrow("original card context");
    expect(handler).not.toHaveBeenCalled();
    expect(chatGet).not.toHaveBeenCalled();
  });
  it("does not access the provider for an unregistered namespace", async () => {
    await expect(dispatch(cfg, event, "unknown:save")).resolves.toEqual({
      matched: false,
      handled: false,
      duplicate: false,
    });
    expect(handler).not.toHaveBeenCalled();
    expect(chatGet).not.toHaveBeenCalled();
  });
});
