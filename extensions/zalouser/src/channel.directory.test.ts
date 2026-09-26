// Zalouser tests cover channelirectory plugin behavior.
import { beforeEach, describe, expect, it } from "vitest";
import "./accounts.test-mocks.js";
import { listZalouserDirectoryGroupMembers } from "./directory.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { listZaloGroupMembersMock } from "./zalo-js.test-mocks.js";

describe("zalouser directory group members", () => {
  beforeEach(() => {
    listZaloGroupMembersMock.mockClear();
  });

  it.each([
    ["group:1471383327500481391", "1471383327500481391"],
    ["1471383327500481391", "1471383327500481391"],
    ["g-1471383327500481391", "g-1471383327500481391"],
  ])("resolves directory group %s to %s", async (groupId, expectedId) => {
    await listZalouserDirectoryGroupMembers(
      { cfg: {}, accountId: "default", groupId },
      { listZaloGroupMembers: listZaloGroupMembersMock },
    );
    expect(listZaloGroupMembersMock).toHaveBeenLastCalledWith("default", expectedId);
  });
});
