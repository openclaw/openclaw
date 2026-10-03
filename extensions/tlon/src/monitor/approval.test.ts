// Tlon tests cover approval plugin behavior.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const cryptoMocks = vi.hoisted(() => ({
  randomBytes: vi.fn(),
}));

vi.mock("node:crypto", () => ({
  randomBytes: cryptoMocks.randomBytes,
}));

let createAuthenticatedDmApproval: typeof import("./approval.js").createAuthenticatedDmApproval;
let createPendingApproval: typeof import("./approval.js").createPendingApproval;
let formatApprovalRequest: typeof import("./approval.js").formatApprovalRequest;

beforeAll(async () => {
  ({ createAuthenticatedDmApproval, createPendingApproval, formatApprovalRequest } =
    await import("./approval.js"));
});

beforeEach(() => {
  cryptoMocks.randomBytes.mockReset();
});

it("records authenticated DM provenance on replayable approvals", () => {
  cryptoMocks.randomBytes.mockReturnValue(Buffer.from("aabbcc", "hex"));
  const approval = createAuthenticatedDmApproval("~bus", {
    messageId: "message-1",
    messageText: "hello",
    messageContent: [],
    timestamp: 1,
  });

  expect(approval.originalMessage?.authenticatedSenderShip).toBe("~bus");
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
