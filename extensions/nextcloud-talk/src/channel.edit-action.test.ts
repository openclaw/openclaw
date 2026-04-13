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

function makeEditCtx(
  params: Record<string, unknown>,
  overrides: Partial<NextcloudTalkActionContext> = {},
): NextcloudTalkActionContext {
  return {
    channel: "nextcloud-talk",
    action: "edit",
    cfg: makeConfiguredCfg(),
    params,
    accountId: "default",
    ...overrides,
  } as NextcloudTalkActionContext;
}

function describedActions(cfg: CoreConfig): string[] {
  return [...(nextcloudTalkPlugin.actions?.describeMessageTool?.({ cfg })?.actions ?? [])];
}

describe("nextcloud-talk edit message action (re-post workaround)", () => {
  beforeEach(() => {
    sendMessageNextcloudTalkMock.mockReset();
    sendMessageNextcloudTalkMock.mockResolvedValue({
      messageId: "101",
      roomToken: "room:abc",
      timestamp: 1_700_000_000,
    });
  });

  it("advertises edit alongside send + react when an account is configured", () => {
    expect(describedActions(makeConfiguredCfg())).toEqual(
      expect.arrayContaining(["send", "react", "edit"]),
    );
  });

  it("supportsAction returns true for edit but not delete", () => {
    expect(nextcloudTalkPlugin.actions?.supportsAction?.({ action: "edit" })).toBe(true);
    expect(
      nextcloudTalkPlugin.actions?.supportsAction?.({
        action: "delete" as NextcloudTalkActionContext["action"],
      }),
    ).toBe(false);
  });

  it("sends a new message prefixed with the edit header and threads it as a reply", async () => {
    const ctx = makeEditCtx({
      to: "room:abc",
      messageId: "42",
      message: "Updated body",
    });

    const result = await nextcloudTalkPlugin.actions?.handleAction?.(ctx);

    expect(sendMessageNextcloudTalkMock).toHaveBeenCalledTimes(1);
    const [toArg, textArg, optsArg] = sendMessageNextcloudTalkMock.mock.calls[0] ?? [];
    expect(toArg).toBe("room:abc");
    expect(textArg).toContain("Edited update");
    expect(textArg).toContain("does not support editing bot messages in place");
    expect(textArg).toContain("Updated body");
    expect(optsArg).toMatchObject({ accountId: "default", replyTo: "42", cfg: ctx.cfg });

    const first = result?.content?.[0];
    if (!first || first.type !== "text") {
      throw new Error("expected text content block");
    }
    const payload = JSON.parse(first.text);
    expect(payload).toMatchObject({
      ok: true,
      channel: "nextcloud-talk",
      messageId: "101",
      originalMessageId: "42",
      replacedAsReply: true,
    });
  });

  it("throws when the target room is missing", async () => {
    await expect(
      nextcloudTalkPlugin.actions?.handleAction?.(makeEditCtx({ messageId: "42", message: "hi" })),
    ).rejects.toThrow(/target/i);
    expect(sendMessageNextcloudTalkMock).not.toHaveBeenCalled();
  });

  it("throws when messageId is missing", async () => {
    await expect(
      nextcloudTalkPlugin.actions?.handleAction?.(makeEditCtx({ to: "room:abc", message: "hi" })),
    ).rejects.toThrow(/messageId/i);
  });

  it("throws when the new message body is missing or empty", async () => {
    await expect(
      nextcloudTalkPlugin.actions?.handleAction?.(makeEditCtx({ to: "room:abc", messageId: "42" })),
    ).rejects.toThrow(/message/i);
    await expect(
      nextcloudTalkPlugin.actions?.handleAction?.(
        makeEditCtx({ to: "room:abc", messageId: "42", message: "   " }),
      ),
    ).rejects.toThrow(/message/i);
  });

  it("accepts target as an alias for to", async () => {
    await nextcloudTalkPlugin.actions?.handleAction?.(
      makeEditCtx({ target: "room:xyz", messageId: "7", message: "via-target" }),
    );
    expect(sendMessageNextcloudTalkMock).toHaveBeenCalledWith(
      "room:xyz",
      expect.stringContaining("via-target"),
      expect.objectContaining({ replyTo: "7" }),
    );
  });
});
