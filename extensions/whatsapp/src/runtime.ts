import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

const runtimeStore = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "whatsapp",
  errorMessage: "WhatsApp runtime not initialized",
});
// The active connection leases belong to the channel runtime that registered them.
// Registry replacements may use another managed instance while the account task is live.
const channelContextOwner = resolveGlobalSingleton(
  Symbol.for("openclaw.whatsapp.channelContextOwner"),
  (): { channel: PluginRuntime["channel"] | null } => ({ channel: null }),
);

/** Injects current helpers while preserving the process-lifetime channel context owner. */
function setWhatsAppRuntime(next: PluginRuntime): void {
  // Plugin registry reloads create fresh runtime objects. Live connection leases must remain
  // readable by outbound sends until their account task explicitly disposes them.
  if (!channelContextOwner.channel) {
    channelContextOwner.channel = next.channel;
  }
  runtimeStore.setRuntime(next);
}

const getWhatsAppRuntime = runtimeStore.getRuntime;
const getOptionalWhatsAppRuntime = runtimeStore.tryGetRuntime;
function getOptionalWhatsAppChannelRuntime(): PluginRuntime["channel"] | null {
  return channelContextOwner.channel;
}

function getWhatsAppChannelRuntime(): PluginRuntime["channel"] {
  const channel = getOptionalWhatsAppChannelRuntime();
  if (!channel) {
    throw new Error("WhatsApp channel runtime not initialized");
  }
  return channel;
}

export {
  getOptionalWhatsAppChannelRuntime,
  getOptionalWhatsAppRuntime,
  getWhatsAppChannelRuntime,
  getWhatsAppRuntime,
  setWhatsAppRuntime,
};
