import { formatChangesDate } from "./utils.js";
async function fetchGroupChanges(api, runtime, daysAgo = 5) {
  try {
    const changeDate = formatChangesDate(daysAgo);
    runtime.log?.(`[tlon] Fetching group changes since ${daysAgo} days ago (${changeDate})...`);
    const changes = await api.scry(`/groups-ui/v5/changes/${changeDate}.json`);
    if (changes) {
      runtime.log?.("[tlon] Successfully fetched changes data");
      return changes;
    }
    return null;
  } catch (error) {
    runtime.log?.(
      `[tlon] Failed to fetch changes (falling back to full init): ${error?.message ?? String(error)}`
    );
    return null;
  }
}
async function fetchInitData(api, runtime) {
  try {
    runtime.log?.("[tlon] Fetching groups-ui init data...");
    const initData = await api.scry("/groups-ui/v6/init.json");
    const channels = [];
    if (initData?.groups) {
      for (const groupData of Object.values(initData.groups)) {
        if (groupData && typeof groupData === "object" && groupData.channels) {
          for (const channelNest of Object.keys(groupData.channels)) {
            if (channelNest.startsWith("chat/")) {
              channels.push(channelNest);
            }
          }
        }
      }
    }
    if (channels.length > 0) {
      runtime.log?.(`[tlon] Auto-discovered ${channels.length} chat channel(s)`);
    } else {
      runtime.log?.("[tlon] No chat channels found via auto-discovery");
    }
    const foreigns = initData?.foreigns || null;
    if (foreigns) {
      const pendingCount = Object.values(foreigns).filter(
        (f) => f.invites?.some((i) => i.valid)
      ).length;
      if (pendingCount > 0) {
        runtime.log?.(`[tlon] Found ${pendingCount} pending group invite(s)`);
      }
    }
    return { channels, foreigns };
  } catch (error) {
    runtime.log?.(`[tlon] Init data fetch failed: ${error?.message ?? String(error)}`);
    return { channels: [], foreigns: null };
  }
}
async function fetchAllChannels(api, runtime) {
  const { channels } = await fetchInitData(api, runtime);
  return channels;
}
export {
  fetchAllChannels,
  fetchGroupChanges,
  fetchInitData
};
