import { describe, expect, it } from "vitest";
import { isParentOwnedBackgroundAcpSession } from "./session-interaction-mode.js";

describe("isParentOwnedBackgroundAcpSession", () => {
  it("returns interactive for persistent ACP sessions without parent linkage", () => {
    expect(
      isParentOwnedBackgroundAcpSession({
        acp: { mode: "persistent" },
      }),
    ).toBe(false);
  });
});
