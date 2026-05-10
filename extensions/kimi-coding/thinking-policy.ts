import type { ProviderThinkingProfile } from "openclaw/plugin-sdk/plugin-entry";

export function resolveKimiThinkingProfile(): ProviderThinkingProfile {
  return {
    levels: [
      { id: "off", label: "off" },
      { id: "low", label: "on" },
    ],
    defaultLevel: "off",
  };
}
