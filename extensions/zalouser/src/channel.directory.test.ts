import { describe, expect, it } from "vitest";
import "./accounts.test-mocks.js";
import { zalouserPlugin } from "./channel.js";
import { createZalouserRuntimeEnv } from "./test-helpers.js";
import "./zalo-js.test-mocks.js";
import { listZaloGroupMembersMock } from "./zalo-js.test-mocks.js";

const runtimeStub = createZalouserRuntimeEnv();

describe("zalouser directory group members", () => {
  it("accepts prefixed group ids from directory groups list output", async () => {
    await zalouserPlugin.directory!.listGroupMembers!({
      cfg: {},
      accountId: "default",
      groupId: "group:1471383327500481391",
      runtime: runtimeStub,
    });

    expect(listZaloGroupMembersMock).toHaveBeenCalledWith("default", "1471383327500481391");
  });

  it("keeps backward compatibility for raw group ids", async () => {
    await zalouserPlugin.directory!.listGroupMembers!({
      cfg: {},
      accountId: "default",
      groupId: "1471383327500481391",
      runtime: runtimeStub,
    });

    expect(listZaloGroupMembersMock).toHaveBeenCalledWith("default", "1471383327500481391");
  });

  it("accepts provider-native g- group ids without stripping the prefix", async () => {
    await zalouserPlugin.directory!.listGroupMembers!({
      cfg: {},
      accountId: "default",
      groupId: "g-1471383327500481391",
      runtime: runtimeStub,
    });

    expect(listZaloGroupMembersMock).toHaveBeenCalledWith("default", "g-1471383327500481391");
  });
});
