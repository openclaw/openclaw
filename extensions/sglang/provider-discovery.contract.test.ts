import { describeSglangProviderDiscoveryContract } from "openclaw/plugin-sdk/provider-test-contracts";

describeSglangProviderDiscoveryContract({
  load: () => import("./index.js"),
});
