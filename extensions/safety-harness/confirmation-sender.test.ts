import { describe, it, expect, vi } from "vitest";
import { ConfirmationSender } from "./confirmation-sender.js";
import type { NonceChallenge } from "./nonce.js";

describe("ConfirmationSender", () => {
  it("sends confirmation message to channel", async () => {
    const sendMock = vi.fn().mockResolvedValue({ ok: true });
    const sender = new ConfirmationSender(sendMock);

    const challenge = {
      nonce: "123456",
      tool: "email.delete",
      params: { count: 3 },
      getPrompt: () =>
        'Frida wants to: email.delete({"count":3}). Reply "CONFIRM 123456" to approve.',
    } as NonceChallenge;

    await sender.send(challenge, "session-123");

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-123",
        content: expect.stringContaining("CONFIRM 123456"),
      }),
    );
  });

  it("tries fallback channels when primary fails", async () => {
    const sendMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("discord unavailable"))
      .mockResolvedValueOnce({ ok: true });
    const sender = new ConfirmationSender(sendMock, ["whatsapp", "telegram", "email"]);

    const challenge = {
      nonce: "123456",
      tool: "email.delete",
      params: { count: 3 },
      getPrompt: () => 'Reply "CONFIRM 123456" to approve.',
    } as NonceChallenge;

    const result = await sender.send(challenge, "session-123");

    expect(result).toBe(true);
    expect(sendMock).toHaveBeenCalledTimes(2); // discord failed, whatsapp succeeded
  });

  it("returns false when all channels fail", async () => {
    const sendMock = vi.fn().mockRejectedValue(new Error("unavailable"));
    const sender = new ConfirmationSender(sendMock, ["whatsapp", "telegram"]);

    const challenge = {
      nonce: "123456",
      tool: "email.delete",
      params: { count: 3 },
      getPrompt: () => 'Reply "CONFIRM 123456" to approve.',
    } as NonceChallenge;

    const result = await sender.send(challenge, "session-123");

    expect(result).toBe(false);
    expect(sendMock).toHaveBeenCalledTimes(3); // discord + 2 fallbacks
  });

  it("includes challenge info in prompt", async () => {
    const sendMock = vi.fn().mockResolvedValue({ ok: true });
    const sender = new ConfirmationSender(sendMock);

    const challenge = {
      nonce: "999999",
      tool: "contacts.export",
      params: {},
      getPrompt: () => 'Frida wants to: contacts.export({}). Reply "CONFIRM 999999" to approve.',
    } as NonceChallenge;

    await sender.send(challenge, "session-456");

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("contacts.export"),
      }),
    );
  });
});
