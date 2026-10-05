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
  const fallback = async (error) => {
    if (!created) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    let currentTab;
    try {
      currentTab = await chromeApi.tabs.get(tabId);
    } catch {
      throw error instanceof Error ? error : new Error(String(error));
    }
    assertCurrent();
    const fallbackGroupId = currentTab.groupId;
    const expectedGroupId =
      Number.isInteger(created.groupOperationGroupId) && created.groupOperationGroupId >= 0
        ? created.groupOperationGroupId
        : undefined;
    const fallbackGroupWasOperationBacked = expectedGroupId !== undefined;
    // Existing groups remain subject to current title authorization. A newly
    // created group is exempt only while it is still unnamed; a readable
    // unrelated title must never be accepted as creation ownership.
    const requiresOpenClawTitle =
      !created.initialGroup || !Number.isInteger(expectedGroupId) || expectedGroupId < 0;
    // The first snapshot can have been queued before the grouping failure was
    // observed. Re-read after the authority check so a delayed tab move cannot
    // be turned into a create-time grant from stale state.
    try {
      currentTab = await chromeApi.tabs.get(tabId);
    } catch {
      throw error instanceof Error ? error : new Error(String(error));
    }
    assertCurrent();
    if (!Number.isInteger(currentTab.groupId) || currentTab.groupId < 0) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    if (expectedGroupId !== undefined && currentTab.groupId !== expectedGroupId) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    let currentGroup;
    try {
      currentGroup = await chromeApi.tabGroups.get(currentTab.groupId);
    } catch {
      currentGroup = undefined;
    }
    const readableGroupTitle = typeof currentGroup?.title === "string";
    const namingWasAttempted = created.initialGroup && created.namingGroup === currentTab.groupId;
    const allowedUnnamedCreationFallback =
      created.initialGroup &&
      !namingWasAttempted &&
      (currentGroup?.title === "" || currentGroup?.title === OPENCLAW_TAB_GROUP_TITLE) &&
      currentGroup.windowId === currentTab.windowId;
    if (
      (requiresOpenClawTitle &&
        (currentGroup?.title !== OPENCLAW_TAB_GROUP_TITLE ||
          currentGroup.windowId !== currentTab.windowId)) ||
      (namingWasAttempted && currentGroup?.title === OPENCLAW_TAB_GROUP_TITLE) ||
      (!requiresOpenClawTitle &&
        readableGroupTitle &&
        !allowedUnnamedCreationFallback &&
        currentGroup?.title !== OPENCLAW_TAB_GROUP_TITLE)
    ) {
      if (!namingWasAttempted) {
        created.revokeCreation?.();
      }
      throw error instanceof Error ? error : new Error(String(error));
    }
    // Some Chromium shells expose grouping but do not reliably expose the
    // resulting group identity. Keep this exception scoped to creation.
    created.groupFallback = true;
    created.groupFallbackRequiresOpenClawTitle = requiresOpenClawTitle;
    if (fallbackGroupWasOperationBacked) {
      created.groupOperationGroupId = expectedGroupId;
    }
    // Keep the intended membership event admissible until handoff. A different
    // group still fails the expectedGroupId check above.
    created.grouping = expectedGroupId !== undefined;
    if (expectedGroupId !== undefined) {
      created.expectedGroupId = expectedGroupId;
    }
    if (
      currentTab.groupId !== fallbackGroupId ||
      (expectedGroupId !== undefined && fallbackGroupId !== expectedGroupId)
    ) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    created.groupId = fallbackGroupId;
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
  } catch (error) {
    await fallback(error);
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
  } catch (error) {
    await fallback(error);
    return;
  }
  assertCurrent();
  if (created) {
    const operationExpectedGroupId = created.expectedGroupId;
    if (created.expectedGroupId !== undefined && created.expectedGroupId !== groupId) {
      throw new Error(`tab ${tabId} group changed during creation`);
    }
    if (created.pendingGroupId !== undefined && created.pendingGroupId !== groupId) {
      throw new Error(`tab ${tabId} group changed during creation`);
    }
    created.groupId = groupId;
    created.expectedGroupId = groupId;
    created.groupOperationGroupId = groupId;
    if (operationExpectedGroupId !== undefined && created.pendingGroupId === undefined) {
      created.pendingGroupId = operationExpectedGroupId;
    }
    if (created.pendingGroupId === groupId) {
      if (created.initialGroup) {
        created.namingGroup = groupId;
      }
      created.grouping = false;
      created.pendingGroupId = undefined;
    }
  }
  if (!group) {
    if (created) {
      created.namingGroup = groupId;
    }
    try {
      await chromeApi.tabGroups.update(groupId, { title: OPENCLAW_TAB_GROUP_TITLE, color });
    } catch (error) {
      await fallback(error);
      return;
    }
    assertCurrent();
  }
  try {
    if (!(await verifyMembership(groupId))) {
      await fallback(new Error(`tab ${tabId} group membership could not be verified`));
    }
  } catch (error) {
    await fallback(error);
  }
}
