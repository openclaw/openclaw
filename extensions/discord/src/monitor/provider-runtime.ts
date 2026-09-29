import {
  listNativeCommandSpecsForConfig,
  listSkillCommandsForAgents,
} from "openclaw/plugin-sdk/command-auth-native";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  resolveNativeCommandsEnabled,
  resolveNativeSkillsEnabled,
} from "openclaw/plugin-sdk/native-command-config-runtime";
import { isVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveDiscordAccount } from "../accounts.js";
import { Client } from "../internal/discord.js";
import { probeDiscordApplicationId } from "../probe.js";
import { createDiscordNativeCommand } from "./native-command.js";
import { runDiscordGatewayLifecycle } from "./provider.lifecycle.js";

const discordVoiceRuntime = createLazyRuntimeModule(() =>
  import("../voice/voice-runtime.js").catch((error: unknown) => {
    discordVoiceRuntime.clear();
    throw error;
  }),
);
const discordProviderSessionRuntime = createLazyRuntimeModule(() =>
  import("./provider-session.runtime.js").catch((error: unknown) => {
    discordProviderSessionRuntime.clear();
    throw error;
  }),
);

export const discordProviderRuntime = {
  probeDiscordApplicationId,
  createDiscordNativeCommand,
  runDiscordGatewayLifecycle,
  loadDiscordVoiceRuntime: () => discordVoiceRuntime(),
  loadDiscordProviderSessionRuntime: () => discordProviderSessionRuntime(),
  createClient: (...args: ConstructorParameters<typeof Client>) => new Client(...args),
  resolveDiscordAccount,
  resolveNativeCommandsEnabled,
  resolveNativeSkillsEnabled,
  listNativeCommandSpecsForConfig,
  listSkillCommandsForAgents,
  isVerbose,
  shouldLogVerbose,
};
