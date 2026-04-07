import { beforeEach, describe, expect, it } from "vitest";
import "./accounts.test-mocks.js";
import { listZalouserDirectoryGroupMembers } from "./directory.js";
import { createZalouserRuntimeEnv } from "./test-helpers.js";
import "./zalo-js.test-mocks.js";
import { listZaloGroupMembersMock } from "./zalo-js.test-mocks.js";

const runtimeStub = createZalouserRuntimeEnv();

describe("zalouser directory group members", () => {
  beforeEach(() => {
    listZaloGroupMembersMock.mockClear();
  });

  it("accepts prefixed group ids from directory groups list output", async () => {
    await listZalouserDirectoryGroupMembers(
      {
        cfg: {},
        accountId: "default",
        groupId: "group:1471383327500481391",
      },
      {
        listZaloGroupMembers: async (profile, groupId) =>
          await listZaloGroupMembersMock(profile, groupId, runtimeStub),
      },
    );

    expect(listZaloGroupMembersMock).toHaveBeenLastCalledWith(
      "default",
      "1471383327500481391",
      runtimeStub,
    );
  });

  it("keeps backward compatibility for raw group ids", async () => {
    await listZalouserDirectoryGroupMembers(
      {
        cfg: {},
        accountId: "default",
        groupId: "1471383327500481391",
      },
      {
        listZaloGroupMembers: async (profile, groupId) =>
          await listZaloGroupMembersMock(profile, groupId, runtimeStub),
      },
    );

    expect(listZaloGroupMembersMock).toHaveBeenLastCalledWith(
      "default",
      "1471383327500481391",
      runtimeStub,
    );
  });

  it("accepts provider-native g- group ids without stripping the prefix", async () => {
    await listZalouserDirectoryGroupMembers(
      {
        cfg: {},
        accountId: "default",
        groupId: "g-1471383327500481391",
      },
      {
        listZaloGroupMembers: async (profile, groupId) =>
          await listZaloGroupMembersMock(profile, groupId, runtimeStub),
      },
    );

    expect(listZaloGroupMembersMock).toHaveBeenLastCalledWith(
      "default",
      "g-1471383327500481391",
      runtimeStub,
    );
  });
});
