import { describePluginRegistrationContract } from "../../test/helpers/plugins/plugin-registration-contract.js";

describePluginRegistrationContract({
  pluginId: "firecrawl",
  webSearchProviderIds: ["firecrawl"],
  toolNames: ["firecrawl_search", "firecrawl_scrape"],
});
