import { OPENCLAW_TAB_GROUP_TITLE } from "./relay-core.js";

/**
 * Ungroup a tab that is the last member of the "OpenClaw" group so closing it
 * dissolves the group instead of leaving another saved "OpenClaw" group behind:
 * Chromium saves a group whose last tab is closed, and saved groups stay
 * invisible to tabGroups.query, so every later job would create a new group.
 * Tabs outside the "OpenClaw" group and other groups are never touched. A
 * failed lookup or ungroup must not block the already-admitted close.
 */
export async function releaseOpenClawGroupBeforeClose(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const groupId = tab?.groupId;
    if (!Number.isInteger(groupId) || groupId < 0) {
      return;
    }
    const group = await chrome.tabGroups.get(groupId);
    if (group?.title !== OPENCLAW_TAB_GROUP_TITLE) {
      return;
    }
    const members = await chrome.tabs.query({ windowId: tab.windowId, groupId });
    if (members.some((member) => member.id !== tabId)) {
      return;
    }
    // Ungrouping fires access-revocation events, but the close is already
    // admitted and Chrome removes the tab regardless of its group state.
    await chrome.tabs.ungroup([tabId]);
  } catch {
    // The close is authorized; a failed lookup or ungroup must not block it.
  }
}

export async function isTabSelected(tab) {
  const groupId = tab?.groupId;
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

export async function addTabToOpenClawGroup(tabId, { chromeApi, getGroupColor, created }) {
  const assertCurrent = () => created?.assertCurrent();
  const tab = await chromeApi.tabs.get(tabId);
  assertCurrent();
  if (created && (tab.groupId !== created.groupId || tab.windowId !== created.tab.windowId)) {
    throw new Error(`tab ${tabId} changed during creation`);
  }
  const groups = await chromeApi.tabGroups
    .query({ title: OPENCLAW_TAB_GROUP_TITLE })
    .catch(() => []);
  assertCurrent();
  const group = groups.find((candidate) => candidate.windowId === tab.windowId);
  const color = group ? undefined : await getGroupColor();
  assertCurrent();
  if (created) {
    created.grouping = true;
    created.initialGroup = !group;
    created.expectedGroupId = group?.id;
  }
  const groupId = await chromeApi.tabs.group({
    tabIds: [tabId],
    ...(group ? { groupId: group.id } : {}),
  });
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
    await chromeApi.tabGroups.update(groupId, { title: OPENCLAW_TAB_GROUP_TITLE, color });
    assertCurrent();
  }
}
