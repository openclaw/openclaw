import { describe, expect, it, vi } from "vitest";
import "./accounts.test-mocks.js";
import { createZalouserRuntimeEnv } from "./test-helpers.js";

const listZaloGroupMembersMock = vi.hoisted(() => vi.fn(async () => []));

vi.mock("./zalo-js.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    listZaloGroupMembers: listZaloGroupMembersMock,
  };
});

import { zalouserPlugin } from "./channel.js";

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
