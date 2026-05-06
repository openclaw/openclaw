import { fileURLToPath } from "node:url";
import { describeGithubCopilotProviderDiscoveryContract } from "openclaw/plugin-sdk/provider-test-contracts";

describeGithubCopilotProviderDiscoveryContract({
  discoveryModuleId: fileURLToPath(new URL("./discovery.js", import.meta.url)),
  load: () => import("./index.js"),
  registerRuntimeModuleId: fileURLToPath(new URL("./register.runtime.js", import.meta.url)),
});
