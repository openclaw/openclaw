import { describe, expect, it, vi } from "vitest";
import "./accounts.test-mocks.js";
import { listZalouserDirectoryGroupMembers } from "./directory.js";

describe("zalouser directory group members", () => {
  it.each([
    {
      name: "accepts prefixed group ids from directory groups list output",
      groupId: "group:1471383327500481391",
      expected: "1471383327500481391",
    },
    {
      name: "keeps backward compatibility for raw group ids",
      groupId: "1471383327500481391",
      expected: "1471383327500481391",
    },
    {
      name: "accepts provider-native g- group ids without stripping the prefix",
      groupId: "g-1471383327500481391",
      expected: "g-1471383327500481391",
    },
  ])("$name", async ({ groupId, expected }) => {
    const listZaloGroupMembers = vi.fn(async () => []);
    await listZalouserDirectoryGroupMembers(
      {
        cfg: {},
        accountId: "default",
        groupId,
      },
      { listZaloGroupMembers },
    );

    expect(listZaloGroupMembers).toHaveBeenLastCalledWith("default", expected);
  });
});
