// The OpenClaw tab group is the user-visible consent boundary: only tabs in that
// group are reported to (and driven by) OpenClaw. These helpers own membership in
// the group; leaving the group revokes agent access.

import { getConfig } from "./config.js";
import { OPENCLAW_TAB_GROUP_TITLE } from "./relay-core.js";

export async function findOpenClawGroups() {
  try {
    return await chrome.tabGroups.query({ title: OPENCLAW_TAB_GROUP_TITLE });
  } catch {
    return [];
  }
}

export async function listSharedTabs() {
  const groups = await findOpenClawGroups();
  const tabs = [];
  for (const group of groups) {
    const groupTabs = await chrome.tabs.query({ groupId: group.id });
    tabs.push(...groupTabs);
  }
  return tabs.filter((tab) => typeof tab.id === "number");
}

export async function addTabToOpenClawGroup(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const groups = await findOpenClawGroups();
  const sameWindowGroup = groups.find((group) => group.windowId === tab.windowId);
  if (sameWindowGroup) {
    await chrome.tabs.group({ tabIds: [tabId], groupId: sameWindowGroup.id });
    return;
  }
  const { groupColor } = await getConfig();
  const groupId = await chrome.tabs.group({ tabIds: [tabId] });
  await chrome.tabGroups.update(groupId, {
    title: OPENCLAW_TAB_GROUP_TITLE,
    color: groupColor,
  });
}

export async function focusWindowForTab(tab) {
  if (typeof tab.windowId === "number") {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
}

export async function removeTabFromOpenClawGroup(tabId) {
  try {
    await chrome.tabs.ungroup([tabId]);
  } catch {
    // tab may already be gone
  }
}

export async function isTabShared(tabId) {
  const shared = await listSharedTabs();
  return shared.some((tab) => tab.id === tabId);
}

export async function isOpenClawGroupId(groupId) {
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
