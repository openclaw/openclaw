import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreConfig } from "./types.js";

const sendReactionNextcloudTalkMock = vi.hoisted(() => vi.fn());
const sendMessageNextcloudTalkMock = vi.hoisted(() => vi.fn());

vi.mock("./send.js", () => ({
  sendMessageNextcloudTalk: sendMessageNextcloudTalkMock,
  sendReactionNextcloudTalk: sendReactionNextcloudTalkMock,
}));

vi.mock("../../../test/helpers/config/bundled-channel-config-runtime.js", () => ({
  getBundledChannelRuntimeMap: () => new Map(),
  getBundledChannelConfigSchemaMap: () => new Map(),
}));

const { nextcloudTalkPlugin } = await import("./channel.js");

type NextcloudTalkHandleAction = NonNullable<
  NonNullable<typeof nextcloudTalkPlugin.actions>["handleAction"]
>;
type NextcloudTalkActionContext = Parameters<NextcloudTalkHandleAction>[0];

function makeConfiguredCfg(): CoreConfig {
  return {
    channels: {
      "nextcloud-talk": {
        baseUrl: "https://cloud.example.com",
        botSecret: "secret-value", // pragma: allowlist secret
      },
    },
  } as CoreConfig;
}

function makeReactCtx(
  params: Record<string, unknown>,
  overrides: Partial<NextcloudTalkActionContext> = {},
): NextcloudTalkActionContext {
  return {
    channel: "nextcloud-talk",
    action: "react",
    cfg: makeConfiguredCfg(),
    params,
    accountId: "default",
    ...overrides,
  } as NextcloudTalkActionContext;
}

function describedActions(cfg: CoreConfig): string[] {
  return [...(nextcloudTalkPlugin.actions?.describeMessageTool?.({ cfg })?.actions ?? [])];
}

describe("nextcloud-talk react message action", () => {
  beforeEach(() => {
    sendReactionNextcloudTalkMock.mockReset();
    sendReactionNextcloudTalkMock.mockResolvedValue({ ok: true });
  });

  it("exposes react + send when an account is fully configured", () => {
    expect(describedActions(makeConfiguredCfg())).toEqual(
      expect.arrayContaining(["send", "react"]),
    );
  });

  it("hides react when no account has credentials", () => {
    const cfg = {
      channels: { "nextcloud-talk": { baseUrl: "https://cloud.example.com" } },
    } as CoreConfig;
    expect(describedActions(cfg)).toEqual([]);
  });

  it("supportsAction claims react only (send stays on outbound.attachedResults)", () => {
    expect(nextcloudTalkPlugin.actions?.supportsAction?.({ action: "react" })).toBe(true);
    expect(nextcloudTalkPlugin.actions?.supportsAction?.({ action: "send" })).toBe(false);
  });

  it("handleAction POSTs the reaction via sendReactionNextcloudTalk", async () => {
    const ctx = makeReactCtx({
      to: "room:abc123",
      messageId: "42",
      emoji: "👍",
    });

    const result = await nextcloudTalkPlugin.actions?.handleAction?.(ctx);

    expect(sendReactionNextcloudTalkMock).toHaveBeenCalledTimes(1);
    expect(sendReactionNextcloudTalkMock).toHaveBeenCalledWith(
      "room:abc123",
      "42",
      "👍",
      expect.objectContaining({ accountId: "default", cfg: ctx.cfg }),
    );
    expect(result?.content?.[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("👍"),
    });
  });

  it("strips surrounding colons from emoji shortcode params", async () => {
    await nextcloudTalkPlugin.actions?.handleAction?.(
      makeReactCtx({ to: "room:abc", messageId: "1", emoji: ":thumbsup:" }),
    );
    expect(sendReactionNextcloudTalkMock).toHaveBeenCalledWith(
      "room:abc",
      "1",
      "thumbsup",
      expect.any(Object),
    );
  });

  it("throws when the target room is missing", async () => {
    await expect(
      nextcloudTalkPlugin.actions?.handleAction?.(makeReactCtx({ messageId: "1", emoji: "👍" })),
    ).rejects.toThrow(/target/i);
    expect(sendReactionNextcloudTalkMock).not.toHaveBeenCalled();
  });

  it("throws when messageId is missing", async () => {
    await expect(
      nextcloudTalkPlugin.actions?.handleAction?.(makeReactCtx({ to: "room:abc", emoji: "👍" })),
    ).rejects.toThrow(/messageId/i);
  });

  it("throws when emoji is missing", async () => {
    await expect(
      nextcloudTalkPlugin.actions?.handleAction?.(makeReactCtx({ to: "room:abc", messageId: "1" })),
    ).rejects.toThrow(/emoji/i);
  });

  it("rejects unsupported actions", async () => {
    await expect(
      nextcloudTalkPlugin.actions?.handleAction?.(
        makeReactCtx({}, { action: "delete" as NextcloudTalkActionContext["action"] }),
      ),
    ).rejects.toThrow(/Unsupported/);
  });
});
