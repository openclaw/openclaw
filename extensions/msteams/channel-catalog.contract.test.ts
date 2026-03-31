import { describeChannelCatalogEntryContract } from "../../test/helpers/channels/channel-catalog-contract.js";

describeChannelCatalogEntryContract({
  channelId: "msteams",
  npmSpec: "@openclaw/msteams",
  alias: "teams",
});
