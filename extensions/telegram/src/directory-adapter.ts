import { createChannelDirectoryAdapter } from "openclaw/plugin-sdk/directory-runtime";
import {
  listTelegramDirectoryGroupsFromConfig,
  listTelegramDirectoryPeersFromConfig,
} from "./directory-config.js";

export const telegramDirectoryAdapter = createChannelDirectoryAdapter({
  listPeers: async (params) => listTelegramDirectoryPeersFromConfig(params),
  listGroups: async (params) => listTelegramDirectoryGroupsFromConfig(params),
  isGroupMember: async (params) => {
    const { isTelegramGroupMember } = await import("./directory-membership-runtime.js");
    return await isTelegramGroupMember(params);
  },
});
