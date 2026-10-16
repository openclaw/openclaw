import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { createSimpleChannelSecretContract } from "openclaw/plugin-sdk/channel-secret-basic-runtime";

export const channelSecrets = createSimpleChannelSecretContract({
  channelKey: "nostr",
  label: "Nostr",
  accountFields: [],
  channelFields: ["privateKey"],
  mode: "channel-only",
  channelAccountId: (channel) =>
    normalizeAccountId(
      typeof channel.defaultAccount === "string" ? channel.defaultAccount : undefined,
    ),
});

export const { secretTargetRegistryEntries, collectRuntimeConfigAssignments } = channelSecrets;
