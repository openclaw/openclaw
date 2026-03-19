import { describe, expect, it, vi } from "vitest";
import { enforceMatrixDirectMessageAccess } from "./access-policy.js";

describe("enforceMatrixDirectMessageAccess", () => {
  it("issues pairing through the injected channel pairing challenge", async () => {
    const issuePairingChallenge = vi.fn(async () => ({ created: true, code: "123456" }));
    const sendPairingReply = vi.fn(async () => {});

    await expect(
      enforceMatrixDirectMessageAccess({
        dmEnabled: true,
        dmPolicy: "pairing",
        accessDecision: "pairing",
        senderId: "@alice:example.com",
        senderName: "Alice",
        effectiveAllowFrom: [],
        issuePairingChallenge,
        sendPairingReply,
        logVerboseMessage: () => {},
      }),
    ).resolves.toBe(false);

    expect(issuePairingChallenge).toHaveBeenCalledTimes(1);
    expect(issuePairingChallenge).toHaveBeenCalledWith(
      expect.objectContaining({
        senderId: "@alice:example.com",
        meta: { name: "Alice" },
        sendPairingReply,
      }),
    );
  });
});
