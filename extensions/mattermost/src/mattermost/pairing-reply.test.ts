import { describe, expect, it, vi } from "vitest";
import { resolveMattermostPairingReply } from "./pairing-reply.js";

describe("Mattermost pairing reply", () => {
  it("renders the pairing code for an admitted request", () => {
    const buildReply = vi.fn(() => "pairing reply");

    expect(resolveMattermostPairingReply({ code: "ABC123", userId: "user-1", buildReply })).toBe(
      "pairing reply",
    );
    expect(buildReply).toHaveBeenCalledWith({
      channel: "mattermost",
      idLine: "Your Mattermost user id: user-1",
      code: "ABC123",
    });
  });

  it.each([undefined, "", "   "])(
    "suppresses the reply when the pending queue returns no code (%j)",
    (code) => {
      const buildReply = vi.fn(() => "unexpected");

      expect(resolveMattermostPairingReply({ code, userId: "user-1", buildReply })).toBeUndefined();
      expect(buildReply).not.toHaveBeenCalled();
    },
  );
});
