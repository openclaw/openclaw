import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies
vi.mock("./client.js", () => ({
  sendEmail: vi.fn(),
  sendReply: vi.fn(),
}));

vi.mock("./auth.js", () => ({
  resolveAccessToken: vi.fn().mockResolvedValue("test-token"),
}));

import { sendEmail, sendReply } from "./client.js";
import { sendOutboundText } from "./outbound.js";

const baseCfg = {
  channels: {
    inboxapi: {
      accessToken: "test-token",
      mcpEndpoint: "https://mcp.inboxapi.ai/mcp",
      fromName: "TestBot",
    },
  },
};

describe("sendOutboundText", () => {
  beforeEach(() => {
    vi.mocked(sendEmail).mockReset();
    vi.mocked(sendReply).mockReset();
  });

  it("sends new email when no replyToId", async () => {
    vi.mocked(sendEmail).mockResolvedValue({ success: true, messageId: "m1" });

    const result = await sendOutboundText({
      to: "user@example.com",
      text: "Hello",
      cfg: baseCfg,
    });

    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "test-token" }),
      expect.objectContaining({
        to: "user@example.com",
        subject: "Message from OpenClaw",
        body: "Hello",
      }),
    );
    expect(result.channel).toBe("inboxapi");
    expect(result.messageId).toBe("m1");
  });

  it("sends reply when replyToId is present", async () => {
    vi.mocked(sendReply).mockResolvedValue({ success: true, messageId: "m2" });

    const result = await sendOutboundText({
      to: "user@example.com",
      text: "Reply text",
      replyToId: "e123",
      cfg: baseCfg,
    });

    expect(sendReply).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "test-token" }),
      expect.objectContaining({
        email_id: "e123",
        body: "Reply text",
      }),
    );
    expect(result.messageId).toBe("m2");
  });

  it("strips inboxapi: prefix from target", async () => {
    vi.mocked(sendEmail).mockResolvedValue({ success: true });

    await sendOutboundText({
      to: "inboxapi:user@example.com",
      text: "Hello",
      cfg: baseCfg,
    });

    expect(sendEmail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ to: "user@example.com" }),
    );
  });

  it("throws when no access token", async () => {
    const { resolveAccessToken } = await import("./auth.js");
    vi.mocked(resolveAccessToken).mockResolvedValueOnce("");

    await expect(
      sendOutboundText({
        to: "user@example.com",
        text: "Hello",
        cfg: { channels: { inboxapi: {} } },
      }),
    ).rejects.toThrow("access token not configured");
  });
});
