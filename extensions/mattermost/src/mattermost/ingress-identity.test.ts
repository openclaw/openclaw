import { resolvePinnedMainDmOwnerFromAllowlist } from "openclaw/plugin-sdk/security-runtime";
import { describe, expect, it } from "vitest";
import { normalizeMattermostAllowEntry } from "./ingress-identity.js";

function pinnedOwner(allowFrom: string[]): string | null {
  return resolvePinnedMainDmOwnerFromAllowlist({
    dmScope: "main",
    allowFrom,
    normalizeEntry: normalizeMattermostAllowEntry,
  });
}

describe("mattermost pinned main-DM owner", () => {
  it.each(["*", "mattermost:*", "user:*"])("leaves the main DM owner unpinned for %s", (entry) => {
    expect(normalizeMattermostAllowEntry(entry)).toBe("*");
    expect(pinnedOwner([entry])).toBeNull();
  });

  it("still pins a single configured owner", () => {
    expect(pinnedOwner(["mattermost:@Owner"])).toBe("owner");
  });
});
