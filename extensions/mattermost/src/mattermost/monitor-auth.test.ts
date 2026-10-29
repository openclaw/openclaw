import { describe, expect, it } from "vitest";
import { normalizeMattermostAllowEntry } from "./ingress-identity.js";
import {
  formatMattermostDirectMessageDropLog,
  isMattermostSenderAllowed,
  normalizeMattermostAllowList,
} from "./monitor-auth.js";

describe("mattermost monitor auth", () => {
  it("normalizes allowlist entries", () => {
    expect(normalizeMattermostAllowEntry(" @Alice ")).toBe("alice");
    expect(normalizeMattermostAllowEntry("mattermost:Bob")).toBe("bob");
    expect(normalizeMattermostAllowEntry("accessGroup:Ops")).toBe("accessGroup:Ops");
    expect(normalizeMattermostAllowEntry("*")).toBe("*");
    expect(normalizeMattermostAllowList([" Alice ", "user:alice", "ALICE", "*"])).toEqual([
      "alice",
      "*",
    ]);
  });

  it.each([
    { allowFrom: [" mattermost:alice "], allowed: true },
    { allowFrom: ["bob"], allowed: false },
  ])(
    "checks sender allowlist $allowFrom against normalized ids and names",
    ({ allowFrom, allowed }) => {
      expect(
        isMattermostSenderAllowed({
          senderId: "@Alice",
          senderName: "Alice",
          allowFrom,
          allowNameMatching: true,
        }),
      ).toBe(allowed);
    },
  );

  it("formats direct-message drops with the ingress reason and open-policy hint", () => {
    expect(
      formatMattermostDirectMessageDropLog({
        senderId: "alice-id",
        dmPolicy: "open",
        reasonCode: "dm_policy_not_allowlisted",
      }),
    ).toBe(
      "mattermost: drop dm sender=alice-id (dmPolicy=open reason=dm_policy_not_allowlisted hint=add-allowFrom-wildcard)",
    );
  });
});
