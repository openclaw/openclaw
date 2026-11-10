import { describe, expect, it } from "vitest";
import {
  buildInviteLink,
  deriveInviteProofKey,
  generateInviteSecret,
  inviteSecretHash,
  parseInviteFragment,
} from "./invites.js";

describe("invite links", () => {
  it("keeps the secret in the fragment and round-trips it", async () => {
    const { invite_id, secret } = generateInviteSecret();
    const rootFp = `fp:${"ab".repeat(32)}` as const;
    const link = buildInviteLink("studio-k7x2q.crabd.me", { invite_id, secret, root_fp: rootFp });
    const url = new URL(link);
    expect(`${url.pathname}${url.search}`).toBe("/join");
    expect(parseInviteFragment(url.hash)).toEqual({ invite_id, secret, root_fp: rootFp });
    expect(parseInviteFragment("#i=nope&r=00")).toBeNull();
    expect(await inviteSecretHash(await deriveInviteProofKey(secret))).toMatch(/^[0-9a-f]{64}$/);
  });
});
