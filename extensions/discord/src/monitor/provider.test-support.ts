import { discordProviderRuntime } from "./provider-runtime.js";

const defaultDiscordProviderRuntime = { ...discordProviderRuntime };

export const discordProviderTestSupport = {
  reset(): void {
    Object.assign(discordProviderRuntime, defaultDiscordProviderRuntime);
  },
  setProbeDiscordApplicationId(mock: typeof discordProviderRuntime.probeDiscordApplicationId) {
    discordProviderRuntime.probeDiscordApplicationId = mock;
  },
  setCreateDiscordNativeCommand(mock: typeof discordProviderRuntime.createDiscordNativeCommand) {
    discordProviderRuntime.createDiscordNativeCommand = mock;
  },
  setRunDiscordGatewayLifecycle(mock: typeof discordProviderRuntime.runDiscordGatewayLifecycle) {
    discordProviderRuntime.runDiscordGatewayLifecycle = mock;
  },
  setLoadDiscordVoiceRuntime(mock: typeof discordProviderRuntime.loadDiscordVoiceRuntime) {
    discordProviderRuntime.loadDiscordVoiceRuntime = mock;
  },
  setLoadDiscordProviderSessionRuntime(
    mock: typeof discordProviderRuntime.loadDiscordProviderSessionRuntime,
  ) {
    discordProviderRuntime.loadDiscordProviderSessionRuntime = mock;
  },
  setCreateClient(mock: typeof discordProviderRuntime.createClient) {
    discordProviderRuntime.createClient = mock;
  },
  setResolveDiscordAccount(mock: typeof discordProviderRuntime.resolveDiscordAccount) {
    discordProviderRuntime.resolveDiscordAccount = mock;
  },
  setResolveNativeCommandsEnabled(
    mock: typeof discordProviderRuntime.resolveNativeCommandsEnabled,
  ) {
    discordProviderRuntime.resolveNativeCommandsEnabled = mock;
  },
  setResolveNativeSkillsEnabled(mock: typeof discordProviderRuntime.resolveNativeSkillsEnabled) {
    discordProviderRuntime.resolveNativeSkillsEnabled = mock;
  },
  setListNativeCommandSpecsForConfig(
    mock: typeof discordProviderRuntime.listNativeCommandSpecsForConfig,
  ) {
    discordProviderRuntime.listNativeCommandSpecsForConfig = mock;
  },
  setPrepareSkillCommandsForAgents(
    mock: typeof discordProviderRuntime.prepareSkillCommandsForAgents,
  ) {
    discordProviderRuntime.prepareSkillCommandsForAgents = mock;
  },
  setIsVerbose(mock: typeof discordProviderRuntime.isVerbose) {
    discordProviderRuntime.isVerbose = mock;
  },
  setShouldLogVerbose(mock: typeof discordProviderRuntime.shouldLogVerbose) {
    discordProviderRuntime.shouldLogVerbose = mock;
  },
};
