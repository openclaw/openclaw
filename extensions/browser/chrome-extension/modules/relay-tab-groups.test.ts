import { describe, expect, it, vi } from "vitest";
import { OPENCLAW_TAB_GROUP_TITLE } from "./relay-core.js";
import { addTabToOpenClawGroup } from "./relay-tab-groups.js";

function createChromeApi({
  group = false,
  groupError,
  renameError,
  groupErrorTargetGroup,
  groupTitle = OPENCLAW_TAB_GROUP_TITLE,
}: {
  group?: boolean;
  groupError?: Error;
  renameError?: Error;
  groupErrorTargetGroup?: number;
  groupTitle?: string;
} = {}) {
  const tab = { id: 1, windowId: 1, groupId: group ? 7 : -1 };
  return {
    tab,
    chromeApi: {
      tabs: {
        get: vi.fn(async () => ({ ...tab })),
        group: vi.fn(async () => {
          if (groupError) {
            tab.groupId = groupErrorTargetGroup ?? 7;
            throw groupError;
          }
          tab.groupId = 7;
          return 7;
        }),
      },
      tabGroups: {
        query: vi.fn(async () => (group ? [{ id: 7, windowId: 1 }] : [])),
        get: vi.fn(async (groupId: number) => ({ id: groupId, title: groupTitle, windowId: 1 })),
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

  it("rejects a fallback that lands in a different group than the intended group", async () => {
    const groupingError = new Error("group identity unavailable");
    const harness = createChromeApi({
      group: true,
      groupError: groupingError,
      groupErrorTargetGroup: 8,
    });
    const created = {
      tab: { ...harness.tab },
      groupId: 7,
      groupFallback: false,
      grouping: true,
      initialGroup: false,
      expectedGroupId: 7,
      groupOperationGroupId: 7,
      assertCurrent: vi.fn(),
    };

    await expect(
      addTabToOpenClawGroup(1, {
        chromeApi: harness.chromeApi,
        getGroupColor: async () => "orange",
        created,
      }),
    ).rejects.toThrow(groupingError.message);
    expect(created.groupFallback).toBe(false);
  });

  it("requires the current group title when group creation never proves ownership", async () => {
    const groupingError = new Error("group identity unavailable");
    const harness = createChromeApi({
      groupError: groupingError,
      groupErrorTargetGroup: 8,
      groupTitle: "Unrelated",
    });
    const created = {
      tab: { ...harness.tab },
      groupId: -1,
      groupFallback: false,
      grouping: true,
      initialGroup: true,
      // Simulate a membership event observed while tabs.group was pending.
      expectedGroupId: 8,
      groupOperationGroupId: undefined,
      assertCurrent: vi.fn(),
    };

    await expect(
      addTabToOpenClawGroup(1, {
        chromeApi: harness.chromeApi,
        getGroupColor: async () => "orange",
        created,
      }),
    ).rejects.toThrow(groupingError.message);
    expect(created.groupFallback).toBe(false);
  });

  it("rejects a renamed creation fallback before granting debugger access", async () => {
    const namingError = new Error("name failed");
    const harness = createChromeApi({ renameError: namingError, groupTitle: "Unrelated" });
    const created = {
      tab: { ...harness.tab },
      groupId: -1,
      groupFallback: false,
      grouping: false,
      initialGroup: true,
      expectedGroupId: 7,
      groupOperationGroupId: 7,
      assertCurrent: vi.fn(),
    };

    await expect(
      addTabToOpenClawGroup(1, {
        chromeApi: harness.chromeApi,
        getGroupColor: async () => "orange",
        created,
      }),
    ).rejects.toThrow(namingError.message);
    expect(created.groupFallback).toBe(false);
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
