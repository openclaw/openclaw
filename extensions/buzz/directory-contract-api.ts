import {
  listBuzzDirectoryGroupsFromConfig,
  listBuzzDirectoryPeersFromConfig,
} from "./src/directory-config.js";

export { listBuzzDirectoryGroupsFromConfig, listBuzzDirectoryPeersFromConfig };

export const buzzDirectoryContractPlugin = {
  id: "buzz",
  directory: {
    listPeers: listBuzzDirectoryPeersFromConfig,
    listGroups: listBuzzDirectoryGroupsFromConfig,
  },
};
