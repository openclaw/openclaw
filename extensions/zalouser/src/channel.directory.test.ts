import { describe, expect, it, vi } from "vitest";
import "./accounts.test-mocks.js";
import { listZalouserDirectoryGroupMembers } from "./directory.js";

describe("zalouser directory group members", () => {
  it.each([
    ["group:1471383327500481391", "1471383327500481391"],
    ["1471383327500481391", "1471383327500481391"],
    ["g-1471383327500481391", "g-1471383327500481391"],
  ])("resolves directory group %s to %s", async (groupId, expectedId) => {
    const listZaloGroupMembers = vi.fn(async () => []);
    await listZalouserDirectoryGroupMembers(
      { cfg: {}, accountId: "default", groupId },
      { listZaloGroupMembers },
    );
    expect(listZaloGroupMembers).toHaveBeenLastCalledWith("default", expectedId);
  });
});
