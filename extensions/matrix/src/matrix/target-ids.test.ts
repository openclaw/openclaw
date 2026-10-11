// Matrix tests cover target-id shape predicates.
import { describe, expect, it } from "vitest";
import { isMatrixInviteAutoJoinTarget, isMatrixRoomId } from "./target-ids.js";

describe("isMatrixRoomId", () => {
  it("rejects an empty room identifier after trimming", () => {
    expect(isMatrixRoomId(" !  ")).toBe(false);
  });
});

describe("isMatrixInviteAutoJoinTarget", () => {
  it.each([
    ["!UIZ0YzC99dC1AyEM6mGl0_XNP8u8xeCCt_Zk8Uhkp70", true],
    ["#support:example.org", true],
    ["!", false],
  ])("classifies %j as matchable=%s", (entry, expected) => {
    expect(isMatrixInviteAutoJoinTarget(entry)).toBe(expected);
  });
});
