import type { APIContainerComponent } from "discord-api-types/v10";
import { ChannelType, ComponentType, MessageFlags } from "discord-api-types/v10";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type { DiscordComponentMessageSpec } from "./components.js";
import { createDiscordLoopbackRest, makeDiscordRest, requestBody } from "./send.test-harness.js";

async function loopbackRest(options?: Parameters<typeof createDiscordLoopbackRest>[0]) {
  const loopback = await createDiscordLoopbackRest(options);
  onTestFinished(loopback.close);
  return loopback;
}

const CFG = { session: { dmScope: "main" } } as const;
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
import { registerDiscordComponentEntries } from "./components-registry.js";
import { editDiscordComponentMessage, sendDiscordComponentMessage } from "./send.components.js";

beforeEach(() => {
  vi.clearAllMocks();
  sendMessageDiscordMock.mockReset();
  loadOutboundMediaFromUrlMock.mockReset();
});
function mediaOptions(rest?: ReturnType<typeof makeDiscordRest>["rest"]) {
  return { ...OPTIONS, rest, mediaUrl: "https://example.com/report.pdf" };
}
const textBlock = (text: string) => ({ type: "text" as const, text });
const delivery = {
  messageId: "1002",
  channelId: "dm-1",
  receipt: { platformMessageIds: ["1002"] },
};

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
      channels: { discord: { agentComponents: { ttlMs: 120_000 } } },
    },
    rest,
    token: "t",
    sessionKey: "agent:main:discord:channel:dm-1",
    agentId: "main",
    onDeliveryResult,
    allowedMentions: { parse: [] },
  };
  let finished: { value?: unknown; error?: unknown } | undefined;
  const pending =
    operation === "send"
      ? sendDiscordComponentMessage("channel:dm-1", BUTTON, opts)
      : editDiscordComponentMessage("channel:dm-1", "1002", BUTTON, opts);
  const outcome = pending.then(
    (value) => (finished = { value }),
    (error: unknown) => (finished = { error }),
  );
  try {
    await registered.promise;
    expect(finished).toBeUndefined();
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
      expect(onDeliveryResult.mock.calls[0]?.[0]).toMatchObject(delivery);
      const error = new Error("registry write failed");
      registration.reject(error);
      expect(await outcome).toEqual({ error });
    } else {
      expect(onDeliveryResult).not.toHaveBeenCalled();
      registration.resolve();
      expect(await outcome).toMatchObject({ value: delivery });
    }
  } finally {
    registration.resolve();
    await outcome;
  }
});

it("rechecks delivery authority before each retried component post", async () => {
  let authorityActive = true;
  const loopback = await loopbackRest({
    status: (request) => {
      if (request.method === "POST") {
        authorityActive = false;
        return 503;
      }
      return 200;
    },
  });
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
});

it.each(["select", "link emoji"] as const)("refreshes registry on %s edit", async (kind) => {
  const sessionKey = "agent:main:discord:channel:chan-1";
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
  const spec: DiscordComponentMessageSpec =
    kind === "select"
      ? {
          text: "Updated picker",
          blocks: [
            {
              type: "actions",
              select: { type: "string", options: [{ label: "One", value: "one" }] },
            },
          ],
        }
      : {
          blocks: [
            { type: "actions", buttons: [docs] },
            {
              type: "section",
              text: "Read the guide",
              accessory: { type: "button", button: { ...guide, style: "link" } },
            },
          ],
        };
  const loopback = await loopbackRest();
  await editDiscordComponentMessage("channel:chan-1", "1001", structuredClone(spec), {
    ...OPTIONS,
    rest: loopback.rest,
    ...(kind === "select" ? { sessionKey, agentId: "main" } : {}),
  });
  const patch = loopback.requests.find((request) => request.method === "PATCH");
  expect(patch?.path).toBe("/v10/channels/chan-1/messages/1001");
  const body: { flags?: number; components?: APIContainerComponent[] } = JSON.parse(
    patch?.body ?? "{}",
  );
  const components = body.components?.[0]?.components;
  const row = components?.find((entry) => entry.type === ComponentType.ActionRow);
  if (kind === "select") {
    expect(body.flags).toBe(MessageFlags.IsComponentsV2);
    expect(row?.components[0]?.type).toBe(ComponentType.StringSelect);
    expect(body).not.toHaveProperty("nonce");
    expect(body).not.toHaveProperty("enforce_nonce");
  } else {
    expect(row?.components[0]).toMatchObject(docs);
    expect(
      components?.find((entry) => entry.type === ComponentType.Section)?.accessory,
    ).toMatchObject(guide);
  }
  expect(registerDiscordComponentEntries).toHaveBeenCalledWith(
    expect.objectContaining(
      kind === "select"
        ? { messageId: "loopback-message", entries: [expect.objectContaining({ sessionKey })] }
        : { entries: [], modals: [] },
    ),
  );
});
it.each(["capability forwarding", "whitespace and repeated text"])(
  "%s in classic media sends",
  async (mode) => {
    const forwardAccess = mode === "capability forwarding";
    const spec = forwardAccess
      ? { blocks: [textBlock("report")] }
      : { text: "    code", blocks: ["    code", " \n\t ", "code", "    code"].map(textBlock) };
    const text = forwardAccess ? "report" : "    code\n\ncode\n\n    code";
    const readFile = vi.fn().mockResolvedValue(Buffer.from("pdf"));
    const mediaAccess = { localRoots: ["/tmp"], readFile };
    const onDeliveryResult = vi.fn();
    const forwarded = forwardAccess
      ? { mediaReadFile: readFile, mediaAccess, onDeliveryResult }
      : {};
    await sendDiscordComponentMessage("channel:chan-1", spec, { ...mediaOptions(), ...forwarded });
    expect(sendMessageDiscordMock).toHaveBeenCalledExactlyOnceWith(
      "channel:chan-1",
      text,
      expect.objectContaining(forwarded),
    );
  },
);

it("derives upload for unnamed application/x-unknown media", async () => {
  const { rest, getMock, postMock } = makeDiscordRest();
  getMock.mockResolvedValueOnce({ type: ChannelType.GuildText, id: "chan-1" });
  postMock.mockResolvedValueOnce({ id: "1001", channel_id: "chan-1" });
  loadOutboundMediaFromUrlMock.mockResolvedValueOnce({
    buffer: Buffer.from("media"),
    contentType: "application/x-unknown",
  });
  await sendDiscordComponentMessage("channel:chan-1", MODAL, mediaOptions(rest));
  expect(requestBody(postMock)).toMatchObject({
    files: [expect.objectContaining({ name: "upload" })],
  });
  expect(sendMessageDiscordMock).not.toHaveBeenCalled();
});
