import { describe, expect, it, vi } from "vitest";
import { OPENCLAW_TAB_GROUP_TITLE } from "./relay-core.js";
import { addTabToOpenClawGroup } from "./relay-tab-groups.js";

function createChromeApi({
  group = false,
  groupError,
  renameError,
}: {
  group?: boolean;
  groupError?: Error;
  renameError?: Error;
} = {}) {
  const tab = { id: 1, windowId: 1, groupId: group ? 7 : -1 };
  return {
    tab,
    chromeApi: {
      tabs: {
        get: vi.fn(async () => ({ ...tab })),
        group: vi.fn(async () => {
          if (groupError) {
            tab.groupId = 7;
            throw groupError;
          }
          tab.groupId = 7;
          return 7;
        }),
      },
      tabGroups: {
        query: vi.fn(async () => (group ? [{ id: 7, windowId: 1 }] : [])),
        get: vi.fn(async () => ({ id: 7, title: OPENCLAW_TAB_GROUP_TITLE, windowId: 1 })),
        update: vi.fn(async () => {
          if (renameError) {
            throw renameError;
          }
        }),
      },
    },
  };
}

describe("addTabToOpenClawGroup", () => {
  it("keeps a creation fallback when grouping assigns membership before failing", async () => {
    const groupingError = new Error("group identity unavailable");
    const harness = createChromeApi({ groupError: groupingError });
    const created = {
      tab: { ...harness.tab },
      groupId: -1,
      groupFallback: false,
      grouping: false,
      expectedGroupId: undefined,
      assertCurrent: vi.fn(),
    };

    await expect(
      addTabToOpenClawGroup(1, {
        chromeApi: harness.chromeApi,
        getGroupColor: async () => "orange",
        created,
      }),
    ).resolves.toBeUndefined();
    expect(created.groupFallback).toBe(true);
    expect(created.groupId).toBe(7);
  });

  it.each([
    { label: "grouping", groupError: new Error("group failed") },
    { label: "naming", renameError: new Error("name failed") },
  ])("propagates manual $label failures", async ({ groupError, renameError }) => {
    const harness = createChromeApi({ groupError, renameError });

    await expect(
      addTabToOpenClawGroup(1, {
        chromeApi: harness.chromeApi,
        getGroupColor: async () => "orange",
      }),
    ).rejects.toThrow((groupError ?? renameError)!.message);
  });
});
