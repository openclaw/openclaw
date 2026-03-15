import { beforeEach, describe, expect, it, vi } from "vitest";

const sendDmMock = vi.hoisted(() => vi.fn());
const sendGroupMessageMock = vi.hoisted(() => vi.fn());
const authenticateMock = vi.hoisted(() => vi.fn());

vi.mock("./urbit/send.js", () => ({
  buildMediaText: (text: string, mediaUrl: string) =>
    mediaUrl ? `${text}\n\n${mediaUrl}`.trim() : text,
  sendDm: sendDmMock,
  sendGroupMessage: sendGroupMessageMock,
}));

vi.mock("./urbit/auth.js", () => ({
  authenticate: authenticateMock,
}));

vi.mock("./urbit/channel-client.js", () => {
  return {
    UrbitChannelClient: class MockUrbitChannelClient {
      close = vi.fn();
      getOurName = vi.fn();
    },
  };
});

vi.mock("./urbit/context.js", () => ({
  ssrfPolicyFromAllowPrivateNetwork: vi.fn(() => "block"),
}));

vi.mock("./types.js", () => ({
  resolveTlonAccount: vi.fn(() => ({
    configured: true,
    ship: "~zod",
    url: "https://zod.example.com",
    code: "test-code",
    allowPrivateNetwork: false,
    accountId: "default",
    name: "default",
    enabled: true,
    config: {},
  })),
  listTlonAccountIds: vi.fn(() => ["default"]),
}));

vi.mock("./targets.js", () => ({
  parseTlonTarget: vi.fn((to: string) => {
    if (to.startsWith("~")) {
      return { kind: "direct", ship: to };
    }
    return null;
  }),
  normalizeShip: vi.fn((ship: string) => ship),
  formatTargetHint: vi.fn(() => "~ship or ~host/channel"),
}));

vi.mock("./account-fields.js", () => ({ buildTlonAccountFields: vi.fn(() => ({})) }));
vi.mock("./config-schema.js", () => ({ tlonChannelConfigSchema: {} }));
vi.mock("./monitor/index.js", () => ({ monitorTlonProvider: vi.fn() }));
vi.mock("./onboarding.js", () => ({ tlonOnboardingAdapter: {} }));

import { tlonPlugin } from "./channel.js";

describe("sendPayload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticateMock.mockResolvedValue("cookie");
    sendDmMock.mockResolvedValue({ channel: "tlon", messageId: "tlon-1" });
    sendGroupMessageMock.mockResolvedValue({ channel: "tlon", messageId: "tlon-1" });
  });

  const baseCtx = {
    to: "~zod",
    text: "",
    cfg: {} as any,
    payload: {} as any,
  };

  it("text-only delegates to sendText", async () => {
    const result = await tlonPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: { text: "hello" },
    });

    expect(sendDmMock).toHaveBeenCalledTimes(1);
    expect(result.channel).toBe("tlon");
  });

  it("single media delegates to sendMedia", async () => {
    const result = await tlonPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: { text: "caption", mediaUrl: "https://example.com/a.png" },
    });

    // sendMedia builds merged text then calls sendText -> sendDm
    expect(sendDmMock).toHaveBeenCalledTimes(1);
    expect(result.channel).toBe("tlon");
  });

  it("multi-media iterates URLs with caption on first", async () => {
    const result = await tlonPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: {
        text: "caption",
        mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
      },
    });

    // Two sendMedia calls -> two sendDm calls
    expect(sendDmMock).toHaveBeenCalledTimes(2);
    expect(result.channel).toBe("tlon");
  });

  it("empty payload returns no-op", async () => {
    const result = await tlonPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: {},
    });

    expect(sendDmMock).not.toHaveBeenCalled();
    expect(result).toEqual({ channel: "tlon", messageId: "" });
  });

  it("returns no-op when chunker produces empty array", async () => {
    tlonPlugin.outbound!.chunker = vi.fn().mockReturnValue([]);
    const sendTextSpy = vi.spyOn(tlonPlugin.outbound!, "sendText");
    const result = await tlonPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: { text: "   " },
    } as never);
    expect(sendTextSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ channel: "tlon", messageId: "" });
    delete (tlonPlugin.outbound as any).chunker;
  });

  it("sends as single chunk when text is within limit", async () => {
    // tlonOutbound.textChunkLimit is 10000, no chunker defined — sends as one
    const text = "A".repeat(5000);
    const result = await tlonPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: { text },
    });

    expect(sendDmMock).toHaveBeenCalledTimes(1);
    expect(result.channel).toBe("tlon");
  });
});
