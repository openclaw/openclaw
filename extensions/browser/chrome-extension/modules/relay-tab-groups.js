import { OPENCLAW_TAB_GROUP_TITLE } from "./relay-core.js";

async function isOpenClawGroupId(groupId) {
  if (!Number.isInteger(groupId) || groupId < 0) {
    return false;
  }
  try {
    const group = await chrome.tabGroups.get(groupId);
    return group.title === OPENCLAW_TAB_GROUP_TITLE;
  } catch {
    return false;
  }
}

export async function isTabSelected(tab) {
  return await isOpenClawGroupId(tab?.groupId);
}

export async function addTabToOpenClawGroup(tabId, { chromeApi, getGroupColor, created }) {
  const assertCurrent = () => created?.assertCurrent();
  const fallback = async () => {
    if (created) {
      // Some Chromium shells expose grouping but do not reliably expose the
      // resulting group identity. Keep this exception scoped to creation.
      created.groupFallback = true;
      created.grouping = false;
      created.expectedGroupId = undefined;
      try {
        const currentTab = await chromeApi.tabs.get(tabId);
        if (Number.isInteger(currentTab.groupId) && currentTab.groupId >= 0) {
          created.groupId = currentTab.groupId;
        }
      } catch {
        // Keep the fallback scoped to this creation even if the follow-up
        // snapshot is unavailable.
      }
    }
  };
  const verifyMembership = async (groupId) => {
    const [currentTab, group] = await Promise.all([
      chromeApi.tabs.get(tabId),
      chromeApi.tabGroups.get(groupId),
    ]);
    return (
      currentTab.groupId === groupId &&
      group.title === OPENCLAW_TAB_GROUP_TITLE &&
      currentTab.windowId === group.windowId
    );
  };
  const tab = await chromeApi.tabs.get(tabId);
  assertCurrent();
  if (created && (tab.groupId !== created.groupId || tab.windowId !== created.tab.windowId)) {
    throw new Error(`tab ${tabId} changed during creation`);
  }
  let groups;
  try {
    groups = await chromeApi.tabGroups.query({ title: OPENCLAW_TAB_GROUP_TITLE });
  } catch {
    await fallback();
    return;
  }
  assertCurrent();
  const group = groups.find((candidate) => candidate.windowId === tab.windowId);
  const color = group ? undefined : await getGroupColor();
  assertCurrent();
  if (created) {
    created.grouping = true;
    created.initialGroup = !group;
    created.expectedGroupId = group?.id;
  }
  let groupId;
  try {
    groupId = await chromeApi.tabs.group({
      tabIds: [tabId],
      ...(group ? { groupId: group.id } : {}),
    });
  } catch {
    await fallback();
    return;
  }
  assertCurrent();
  if (created) {
    if (created.expectedGroupId !== undefined && created.expectedGroupId !== groupId) {
      throw new Error(`tab ${tabId} group changed during creation`);
    }
    created.groupId = groupId;
    created.expectedGroupId = groupId;
  }
  if (!group) {
    if (created) {
      created.namingGroup = groupId;
    }
    try {
      await chromeApi.tabGroups.update(groupId, { title: OPENCLAW_TAB_GROUP_TITLE, color });
    } catch {
      await fallback();
      return;
    }
    assertCurrent();
  }
  try {
    if (!(await verifyMembership(groupId))) {
      await fallback();
    }
  } catch {
    await fallback();
  }
}
