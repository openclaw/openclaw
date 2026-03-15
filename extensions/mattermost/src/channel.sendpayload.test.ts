import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./runtime.js", () => ({
  getMattermostRuntime: () => ({
    channel: {
      text: {
        chunkMarkdownText: (text: string, limit: number) => {
          if (text.length <= limit) return [text];
          const chunks: string[] = [];
          for (let i = 0; i < text.length; i += limit) chunks.push(text.slice(i, i + limit));
          return chunks;
        },
      },
    },
  }),
}));

vi.mock("./mattermost/send.js", () => ({
  sendMessageMattermost: vi.fn().mockResolvedValue({ messageId: "mm1" }),
}));

vi.mock("./mattermost/accounts.js", () => ({
  listMattermostAccountIds: () => ["default"],
  resolveDefaultMattermostAccountId: () => "default",
  resolveMattermostAccount: () => ({
    accountId: "default",
    enabled: true,
    botToken: "tok",
    baseUrl: "https://mm.test",
    config: {},
  }),
}));

vi.mock("./mattermost/monitor.js", () => ({
  monitorMattermostProvider: vi.fn(),
}));

vi.mock("./mattermost/probe.js", () => ({
  probeMattermost: vi.fn(),
}));

vi.mock("./mattermost/reactions.js", () => ({
  addMattermostReaction: vi.fn(),
  removeMattermostReaction: vi.fn(),
}));

vi.mock("./mattermost/client.js", () => ({
  normalizeMattermostBaseUrl: (url: string) => url,
}));

vi.mock("./onboarding.js", () => ({
  mattermostOnboardingAdapter: {},
}));

vi.mock("./normalize.js", () => ({
  looksLikeMattermostTargetId: () => true,
  normalizeMattermostMessagingTarget: (t: string) => t,
}));

vi.mock("./group-mentions.js", () => ({
  resolveMattermostGroupRequireMention: () => false,
}));

vi.mock("./config-schema.js", () => ({
  MattermostConfigSchema: {},
}));

import { mattermostPlugin } from "./channel.js";

describe("sendPayload", () => {
  const sendText = vi.fn().mockResolvedValue({ channel: "mattermost", messageId: "t1" });
  const sendMedia = vi.fn().mockResolvedValue({ channel: "mattermost", messageId: "m1" });

  beforeEach(() => {
    vi.clearAllMocks();
    sendText.mockResolvedValue({ channel: "mattermost", messageId: "t1" });
    sendMedia.mockResolvedValue({ channel: "mattermost", messageId: "m1" });
    mattermostPlugin.outbound!.sendText = sendText;
    mattermostPlugin.outbound!.sendMedia = sendMedia;
  });

  const baseCtx = { cfg: {} as any, to: "chan123", accountId: "default" };

  it("delegates text-only payload to sendText", async () => {
    const result = await mattermostPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: { text: "hello" },
    } as any);
    expect(sendText).toHaveBeenCalledOnce();
    expect(sendText.mock.calls[0][0]).toMatchObject({ text: "hello" });
    expect(sendMedia).not.toHaveBeenCalled();
    expect(result).toEqual({ channel: "mattermost", messageId: "t1" });
  });

  it("delegates single-media payload to sendMedia", async () => {
    const result = await mattermostPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: { text: "cap", mediaUrl: "https://img.png" },
    } as any);
    expect(sendMedia).toHaveBeenCalledOnce();
    expect(sendMedia.mock.calls[0][0]).toMatchObject({ text: "cap", mediaUrl: "https://img.png" });
    expect(result).toEqual({ channel: "mattermost", messageId: "m1" });
  });

  it("iterates multi-media URLs with caption on first only", async () => {
    const result = await mattermostPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: { text: "cap", mediaUrls: ["https://a.png", "https://b.png", "https://c.png"] },
    } as any);
    expect(sendMedia).toHaveBeenCalledTimes(3);
    expect(sendMedia.mock.calls[0][0]).toMatchObject({ text: "cap", mediaUrl: "https://a.png" });
    expect(sendMedia.mock.calls[1][0]).toMatchObject({ text: "", mediaUrl: "https://b.png" });
    expect(sendMedia.mock.calls[2][0]).toMatchObject({ text: "", mediaUrl: "https://c.png" });
    expect(result).toEqual({ channel: "mattermost", messageId: "m1" });
  });

  it("returns no-op for empty payload", async () => {
    const result = await mattermostPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: {},
    } as any);
    expect(sendText).not.toHaveBeenCalled();
    expect(sendMedia).not.toHaveBeenCalled();
    expect(result).toEqual({ channel: "mattermost", messageId: "" });
  });

  it("returns no-op when chunker produces empty array", async () => {
    const chunkerSpy = vi.spyOn(mattermostPlugin.outbound! as any, "chunker").mockReturnValue([]);
    const sendTextSpy = vi.spyOn(mattermostPlugin.outbound!, "sendText");
    const result = await mattermostPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: { text: "   " },
    } as never);
    expect(sendTextSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ channel: "mattermost", messageId: "" });
    chunkerSpy.mockRestore();
  });

  it("chunks long text before calling sendText", async () => {
    const longText = "x".repeat(8000);
    await mattermostPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: { text: longText },
    } as any);
    // textChunkLimit is 4000, chunker splits into 2 chunks
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(sendText.mock.calls[0][0].text).toBe("x".repeat(4000));
    expect(sendText.mock.calls[1][0].text).toBe("x".repeat(4000));
  });
});
