import { describe, expect, it } from "vitest";
import {
  isParentOwnedBackgroundAcpSession,
  isRequesterParentOfBackgroundAcpSession,
} from "./session-interaction-mode.js";

const parentKey = "agent:main:main";
const otherKey = "agent:peer:some-other";

describe("isParentOwnedBackgroundAcpSession", () => {
  it("returns interactive for persistent ACP sessions without parent linkage", () => {
    expect(
      isParentOwnedBackgroundAcpSession({
        acp: { mode: "persistent" },
      }),
    ).toBe(false);
  });
});

describe("isRequesterParentOfBackgroundAcpSession", () => {
  const backgroundEntry = {
    acp: { mode: "oneshot" },
    spawnedBy: parentKey,
    parentSessionKey: parentKey,
  };

  it("returns true when requester matches spawnedBy", () => {
    expect(
      isRequesterParentOfBackgroundAcpSession(
        { acp: { mode: "oneshot" }, spawnedBy: parentKey },
        parentKey,
      ),
    ).toBe(true);
  });

  it("returns true when requester matches parentSessionKey", () => {
    expect(
      isRequesterParentOfBackgroundAcpSession(
        { acp: { mode: "oneshot" }, parentSessionKey: parentKey },
        parentKey,
      ),
    ).toBe(true);
  });

  it("returns false when requester is a different session (not the parent)", () => {
    expect(isRequesterParentOfBackgroundAcpSession(backgroundEntry, otherKey)).toBe(false);
  });

  it("returns false when requester key is missing", () => {
    expect(isRequesterParentOfBackgroundAcpSession(backgroundEntry, undefined)).toBe(false);
    expect(isRequesterParentOfBackgroundAcpSession(backgroundEntry, "")).toBe(false);
  });
});
