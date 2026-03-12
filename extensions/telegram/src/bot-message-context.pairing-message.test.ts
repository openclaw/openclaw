import { describe, expect, it, vi } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";
import { enforceTelegramDmAccess } from "./dm-access.js";

vi.mock("./dm-access.js", () => ({
  enforceTelegramDmAccess: vi.fn().mockResolvedValue(true),
}));

describe("buildTelegramMessageContext pairing message propagation", () => {
  it("passes pairingMessage config to DM access enforcement", async () => {
    const pairingMessage = { header: "Custom" } as const;

    await buildTelegramMessageContextForTest({
      message: {
        chat: { id: 123, type: "private" },
      },
      dmPolicy: "pairing",
      pairingMessage,
    });

    expect(vi.mocked(enforceTelegramDmAccess)).toHaveBeenCalledWith(
      expect.objectContaining({ pairingMessage }),
    );
  });
});
