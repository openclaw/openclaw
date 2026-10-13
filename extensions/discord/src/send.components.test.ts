import {
  ChannelType,
  ComponentType,
  MessageFlags,
  type APIContainerComponent,
} from "discord-api-types/v10";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { DiscordComponentMessageSpec } from "./components.js";
import { createDiscordLoopbackRest, makeDiscordRest, requestBody } from "./send.test-harness.js";

const CFG = {
  channels: { discord: { accounts: { default: {} } } },
  session: { dmScope: "main" },
} as const;
const OPTIONS = { cfg: CFG, token: "t" };
const BUTTON: DiscordComponentMessageSpec = {
  blocks: [{ type: "actions", buttons: [{ label: "Tap" }] }],
};
const MODAL: DiscordComponentMessageSpec = {
  text: "report",
  modal: { title: "Feedback", fields: [{ type: "text", label: "Notes" }] },
};
const sendMessageDiscordMock = vi.hoisted(() => vi.fn());
const loadOutboundMediaFromUrlMock = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/plugin-config-runtime", async () => ({
  ...(await vi.importActual<typeof import("openclaw/plugin-sdk/plugin-config-runtime")>(
    "openclaw/plugin-sdk/plugin-config-runtime",
  )),
  loadConfig: () => ({ session: { dmScope: "main" } }),
}));
vi.mock("./components-registry.js", () => ({
  registerDiscordComponentEntries: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./send.outbound.js", () => ({ sendMessageDiscord: sendMessageDiscordMock }));
vi.mock("openclaw/plugin-sdk/outbound-media", async () => ({
  ...(await vi.importActual<typeof import("openclaw/plugin-sdk/outbound-media")>(
    "openclaw/plugin-sdk/outbound-media",
  )),
  loadOutboundMediaFromUrl: loadOutboundMediaFromUrlMock,
}));
let registerDiscordComponentEntries: typeof import("./components-registry.js").registerDiscordComponentEntries;
let editDiscordComponentMessage: typeof import("./send.components.js").editDiscordComponentMessage;
let sendDiscordComponentMessage: typeof import("./send.components.js").sendDiscordComponentMessage;

beforeAll(async () => {
  ({ registerDiscordComponentEntries } = await import("./components-registry.js"));
  ({ editDiscordComponentMessage, sendDiscordComponentMessage } =
    await import("./send.components.js"));
});
beforeEach(() => {
  vi.clearAllMocks();
  sendMessageDiscordMock.mockReset().mockResolvedValue({ messageId: "1001", channelId: "chan-1" });
  loadOutboundMediaFromUrlMock.mockReset().mockResolvedValue({
    buffer: Buffer.from("media"),
    fileName: "report.pdf",
    contentType: "application/pdf",
  });
});
function channelRest() {
  const mocks = makeDiscordRest();
  mocks.getMock.mockResolvedValueOnce({ type: ChannelType.GuildText, id: "chan-1" });
  mocks.postMock.mockResolvedValueOnce({ id: "1001", channel_id: "chan-1" });
  return mocks;
}
function mediaOptions(rest?: ReturnType<typeof makeDiscordRest>["rest"]) {
  return { ...OPTIONS, rest, mediaUrl: "https://example.com/report.pdf" };
}

it.each(["send", "edit"] as const)("awaits registry settlement after %s", async (operation) => {
  const { rest, postMock, patchMock, getMock } = makeDiscordRest();
  getMock.mockResolvedValueOnce({ type: ChannelType.DM, recipients: [{ id: "user-1" }] });
  postMock.mockResolvedValueOnce({ id: "1002", channel_id: "dm-1" });
  patchMock.mockResolvedValueOnce({ id: "1002", channel_id: "dm-1" });
  const registered = Promise.withResolvers<void>();
  const registration = Promise.withResolvers<void>();
  const registerMock = vi.mocked(registerDiscordComponentEntries);
  registerMock.mockImplementationOnce(() => {
    registered.resolve();
    return registration.promise;
  });
  const onDeliveryResult = vi.fn();
  const opts = {
    cfg: {
      ...CFG,
      channels: { discord: { ...CFG.channels.discord, agentComponents: { ttlMs: 120_000 } } },
    },
    rest,
    token: "t",
    sessionKey: "agent:main:discord:channel:dm-1",
    agentId: "main",
    onDeliveryResult,
    allowedMentions: { parse: [] },
  };
  let finished = false;
  const pending =
    operation === "send"
      ? sendDiscordComponentMessage("channel:dm-1", BUTTON, opts)
      : editDiscordComponentMessage("channel:dm-1", "1002", BUTTON, opts);
  const outcome = pending.then(
    (value) => {
      finished = true;
      return { value };
    },
    (error: unknown) => {
      finished = true;
      return { error };
    },
  );
  try {
    await registered.promise;
    expect(finished).toBe(false);
    expect(registerMock).toHaveBeenCalledOnce();
    expect(registerMock.mock.calls[0]?.[0]).toMatchObject({
      messageId: "1002",
      ttlMs: 120_000,
      entries: [expect.objectContaining({ sessionKey: opts.sessionKey })],
    });
    const platformMock = operation === "send" ? postMock : patchMock;
    expect(platformMock).toHaveBeenCalledOnce();
    expect(requestBody(platformMock)).toMatchObject({ allowed_mentions: { parse: [] } });
    if (operation === "send") {
      expect(onDeliveryResult).toHaveBeenCalledOnce();
      expect(onDeliveryResult.mock.calls[0]?.[0]).toMatchObject({
        messageId: "1002",
        channelId: "dm-1",
        receipt: { platformMessageIds: ["1002"] },
      });
      const error = new Error("registry write failed");
      registration.reject(error);
      expect(await outcome).toEqual({ error });
    } else {
      expect(onDeliveryResult).not.toHaveBeenCalled();
      registration.resolve();
      expect(await outcome).toMatchObject({
        value: {
          messageId: "1002",
          channelId: "dm-1",
          receipt: { platformMessageIds: ["1002"] },
        },
      });
    }
  } finally {
    registration.resolve();
    await outcome;
  }
});

it("rechecks delivery authority before each retried component post", async () => {
  let authorityActive = true;
  const loopback = await createDiscordLoopbackRest({
    status: (request) => {
      if (request.method === "POST") {
        authorityActive = false;
        return 503;
      }
      return 200;
    },
  });
  try {
    const revoked = new Error("delivery authority revoked");
    const onPlatformSendDispatch = vi.fn(async () => {
      if (!authorityActive) {
        throw revoked;
      }
    });
    await expect(
      sendDiscordComponentMessage("channel:789", BUTTON, {
        ...OPTIONS,
        rest: loopback.rest,
        onPlatformSendDispatch,
      }),
    ).rejects.toBe(revoked);
    expect(onPlatformSendDispatch).toHaveBeenCalledTimes(2);
    expect(loopback.requests.filter((request) => request.method === "POST")).toHaveLength(1);
  } finally {
    await loopback.close();
  }
});

it("edits select messages without create nonces and refreshes registry entries", async () => {
  const loopback = await createDiscordLoopbackRest();
  try {
    await editDiscordComponentMessage(
      "channel:chan-1",
      "1001",
      {
        text: "Updated picker",
        blocks: [
          {
            type: "actions",
            select: { type: "string", options: [{ label: "One", value: "one" }] },
          },
        ],
      },
      {
        ...OPTIONS,
        rest: loopback.rest,
        sessionKey: "agent:main:discord:channel:chan-1",
        agentId: "main",
      },
    );
    const patch = loopback.requests.find((request) => request.method === "PATCH");
    expect(patch?.path).toBe("/v10/channels/chan-1/messages/1001");
    const body: { flags?: number; components?: APIContainerComponent[] } = JSON.parse(
      patch?.body ?? "{}",
    );
    expect(body.flags).toBe(MessageFlags.IsComponentsV2);
    const row = body.components?.[0]?.components.find(
      (entry) => entry.type === ComponentType.ActionRow,
    );
    expect(row?.components[0]?.type).toBe(ComponentType.StringSelect);
    expect(body).not.toHaveProperty("nonce");
    expect(body).not.toHaveProperty("enforce_nonce");
    expect(registerDiscordComponentEntries).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "loopback-message",
        entries: [expect.objectContaining({ sessionKey: "agent:main:discord:channel:chan-1" })],
      }),
    );
  } finally {
    await loopback.close();
  }
});

it("preserves link-button emoji in rows and sections", async () => {
  const loopback = await createDiscordLoopbackRest();
  try {
    const docs = {
      label: "Docs",
      url: "https://example.test/docs",
      emoji: { name: "📖" },
      disabled: true,
    };
    const guide = {
      label: "Guide",
      url: "https://example.test/guide",
      emoji: { id: "123456789012345678", name: "guide", animated: true },
    };
    await editDiscordComponentMessage(
      "channel:789",
      "1003",
      {
        blocks: [
          { type: "actions", buttons: [docs] },
          {
            type: "section",
            text: "Read the guide",
            accessory: {
              type: "button",
              button: { ...guide, style: "link" },
            },
          },
        ],
      },
      { ...OPTIONS, rest: loopback.rest },
    );
    const patch = loopback.requests.find((entry) => entry.method === "PATCH");
    const body: { components?: APIContainerComponent[] } = JSON.parse(patch?.body ?? "{}");
    const components = body.components?.[0]?.components;
    const row = components?.find((entry) => entry.type === ComponentType.ActionRow);
    const section = components?.find((entry) => entry.type === ComponentType.Section);
    expect(row?.components[0]).toMatchObject({
      url: "https://example.test/docs",
      emoji: { name: "📖" },
      disabled: true,
    });
    expect(section?.accessory).toMatchObject({
      url: "https://example.test/guide",
      emoji: { id: "123456789012345678", name: "guide", animated: true },
    });
    expect(registerDiscordComponentEntries).toHaveBeenCalledWith(
      expect.objectContaining({ entries: [], modals: [] }),
    );
  } finally {
    await loopback.close();
  }
});
it("forwards the media access capability and delivery callback", async () => {
  const readFile = vi.fn().mockResolvedValue(Buffer.from("pdf"));
  const mediaAccess = { localRoots: ["/tmp"], readFile };
  const onDeliveryResult = vi.fn();
  await sendDiscordComponentMessage(
    "channel:chan-1",
    { blocks: [{ type: "text", text: "report" }] },
    {
      ...mediaOptions(),
      mediaReadFile: readFile,
      mediaAccess,
      onDeliveryResult,
    },
  );
  expect(sendMessageDiscordMock).toHaveBeenCalledOnce();
  expect(sendMessageDiscordMock).toHaveBeenCalledWith(
    "channel:chan-1",
    "report",
    expect.objectContaining({
      mediaReadFile: readFile,
      mediaAccess,
      onDeliveryResult,
    }),
  );
});

it("preserves indentation and later repetitions while removing only the leading fallback duplicate", async () => {
  await sendDiscordComponentMessage(
    "channel:chan-1",
    {
      text: "    code",
      blocks: [
        { type: "text", text: "    code" },
        { type: "text", text: " \n\t " },
        { type: "text", text: "code" },
        { type: "text", text: "    code" },
      ],
    },
    mediaOptions(),
  );
  expect(sendMessageDiscordMock).toHaveBeenCalledOnce();
  expect(sendMessageDiscordMock.mock.calls[0]?.[1]).toBe("    code\n\ncode\n\n    code");
});

it.each([{ contentType: "application/x-unknown", name: "upload" }])(
  "derives $name for unnamed $contentType media",
  async ({ contentType, name }) => {
    const { rest, postMock } = channelRest();
    loadOutboundMediaFromUrlMock.mockResolvedValueOnce({
      buffer: Buffer.from("media"),
      contentType,
    });
    await sendDiscordComponentMessage("channel:chan-1", MODAL, mediaOptions(rest));
    expect(requestBody(postMock)).toMatchObject({ files: [expect.objectContaining({ name })] });
    expect(sendMessageDiscordMock).not.toHaveBeenCalled();
  },
);
