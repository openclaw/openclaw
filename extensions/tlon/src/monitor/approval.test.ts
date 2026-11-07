// Tlon tests cover approval plugin behavior.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const cryptoMocks = vi.hoisted(() => ({
  randomBytes: vi.fn(),
}));

vi.mock("node:crypto", () => ({
  randomBytes: cryptoMocks.randomBytes,
}));

let createPendingApproval: typeof import("./approval.js").createPendingApproval;
let formatApprovalRequest: typeof import("./approval.js").formatApprovalRequest;

beforeAll(async () => {
  ({ createPendingApproval, formatApprovalRequest } = await import("./approval.js"));
});

beforeEach(() => {
  cryptoMocks.randomBytes.mockReset();
});

describe("createPendingApproval ID", () => {
  it("uses secure hex entropy while preserving the ID format", () => {
    cryptoMocks.randomBytes.mockReturnValueOnce(Buffer.from("a1b2c3", "hex"));
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_717_171_717_171);

    try {
      const approval = createPendingApproval({ type: "dm", requestingShip: "~sampel-palnet" });
      expect(approval.id).toBe("dm-1717171717171-a1b2c3");
      expect(cryptoMocks.randomBytes).toHaveBeenCalledWith(3);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

it("keeps the stored and rendered approval preview on a UTF-16 boundary", () => {
  cryptoMocks.randomBytes.mockReturnValue(Buffer.from("aabbcc", "hex"));
  // The emoji straddles the 100-code-unit preview boundary.
  const approval = createPendingApproval({
    type: "dm",
    requestingShip: "~sampel-palnet",
    messagePreview: "a".repeat(99) + "\uD83D\uDE00tail",
  });

  expect(approval.messagePreview).toBe("a".repeat(99));
  expect(/[\uD800-\uDFFF]/.test(formatApprovalRequest(approval))).toBe(false);
});

describe("formatApprovalRequest club replay explanation", () => {
  it("says the message will be answered only when it was stored for replay", () => {
    cryptoMocks.randomBytes.mockReturnValue(Buffer.from("aabbcc", "hex"));
    const stored = formatApprovalRequest(
      createPendingApproval({
        type: "dm",
        requestingShip: "~nec",
        clubId: "0v3.club",
        messagePreview: "hello",
        originalMessage: {
          messageId: "m1",
          messageText: "hello",
          messageContent: [{ inline: ["hello"] }],
          timestamp: 1,
        },
      }),
    );
    expect(stored).toContain(
      "The message is answered as an unverified group DM sender, never as ~nec.",
    );
    expect(stored).not.toContain("will not be answered");

    const suppressed = formatApprovalRequest(
      createPendingApproval({
        type: "dm",
        requestingShip: "~nec",
        clubId: "0v3.club",
        messagePreview: "hello",
      }),
    );
    expect(suppressed).toContain(
      "The message is not kept, so it will not be answered; have ~nec send it again in a normal direct message to get a reply.",
    );
    expect(suppressed).not.toContain("The message is answered");
  });
});

describe("formatApprovalRequest decision instructions", () => {
  it.each([
    { type: "dm", requestingShip: "~nec" },
    { type: "channel", requestingShip: "~nec", channelNest: "chat/~nec/general" },
    { type: "group", requestingShip: "~nec", groupFlag: "~nec/test" },
  ] as const)("explains bare and ID-qualified $type decisions", (params) => {
    cryptoMocks.randomBytes.mockReturnValue(Buffer.from("aabbcc", "hex"));
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_717_171_717_171);

    try {
      const message = formatApprovalRequest(createPendingApproval(params));
      const id = `${params.type}-1717171717171-aabbcc`;
      expect(message).toContain(
        'Reply "approve", "deny", or "block" if this is the only pending request.',
      );
      expect(message).toContain(`"approve ${id}", "deny ${id}", or "block ${id}"`);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
