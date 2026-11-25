// Imessage tests cover approval auth plugin behavior.
import { describe, expect, it } from "vitest";
import { getIMessageApprovalApprovers, imessageApprovalAuth } from "./approval-auth.js";

describe("imessageApprovalAuth", () => {
  it("supports explicit wildcard approval approvers", () => {
    expect(
      imessageApprovalAuth.authorizeActorAction({
        cfg: { channels: { imessage: { allowFrom: ["*"] } } },
        senderId: "+15551230000",
        action: "approve",
        approvalKind: "plugin",
      }),
    ).toEqual({ authorized: true });
  });

  it("rejects chat_id / chat_guid / chat_identifier as approver entries even with service prefixes", () => {
    expect(
      getIMessageApprovalApprovers({
        cfg: {
          channels: {
            imessage: {
              allowFrom: [
                "chat_id:42",
                "chat_guid:iMessage;+;chat42",
                "chat_identifier:chat42@example.com",
                "imessage:chat_id:43",
              ],
            },
          },
        },
      }),
    ).toEqual([]);
  });
});
