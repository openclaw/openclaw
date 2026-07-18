// Packed Plugin Sdk Type Smoke script supports OpenClaw repository automation.
type PublicPluginSdkModules = [
  typeof import("openclaw/plugin-sdk"),
  typeof import("openclaw/plugin-sdk/channel-entry-contract"),
  typeof import("openclaw/plugin-sdk/config-contracts"),
  typeof import("openclaw/plugin-sdk/provider-entry"),
  typeof import("openclaw/plugin-sdk/runtime-env"),
];

type ComputerUseProviderDescriptor =
  import("openclaw/plugin-sdk/plugin-entry").ComputerUseProviderDescriptor;

const computerUseProvider = {
  id: "fixture-computer-use",
  label: "Fixture Computer Use",
} satisfies ComputerUseProviderDescriptor;

function registerComputerUseProvider(api: import("openclaw/plugin-sdk").OpenClawPluginApi) {
  api.registerComputerUseProvider(computerUseProvider);
}

const resolvedModules = null as unknown as PublicPluginSdkModules;

void resolvedModules;
void registerComputerUseProvider;
