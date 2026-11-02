import { createAsyncLock } from "openclaw/plugin-sdk/async-lock-runtime";
import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { DiscordComponentEntry, DiscordModalEntry } from "./components.js";

export type PersistedDiscordRegistryEntry<T extends { id: string }> = {
  version: 1;
  entry: T;
};

export type DiscordRegistryStore<T extends { id: string }> = Pick<
  PluginStateKeyedStore<PersistedDiscordRegistryEntry<T>>,
  "register" | "lookup" | "consume" | "delete"
>;

export const discordComponentRegistryState = resolveGlobalSingleton(
  Symbol.for("openclaw.discord.componentRegistryState"),
  () => ({
    withRegistryLock: createAsyncLock(),
    componentEntries: new Map<string, DiscordComponentEntry>(),
    modalEntries: new Map<string, DiscordModalEntry>(),
    persistentComponentStore: undefined as DiscordRegistryStore<DiscordComponentEntry> | undefined,
    persistentModalStore: undefined as DiscordRegistryStore<DiscordModalEntry> | undefined,
    persistentRegistryDisabled: false,
  }),
  (state) =>
    state.withRegistryLock(async () => {
      state.componentEntries.clear();
      state.modalEntries.clear();
      state.persistentComponentStore = undefined;
      state.persistentModalStore = undefined;
      state.persistentRegistryDisabled = false;
    }),
);
