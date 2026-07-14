// Doctor contract metadata for OpenAI provider session-route cleanup.
import type { DoctorSessionRouteStateOwner } from "openclaw/plugin-sdk/runtime-doctor";

/** OpenAI currently has no legacy plugin config migrations. */
export const legacyConfigRules = [];

/** Session-route ownership metadata for canonical OpenAI provider sessions. */
export const sessionRouteStateOwners: DoctorSessionRouteStateOwner[] = [
  {
    id: "openai",
    label: "OpenAI",
    providerIds: ["openai"],
    authProfilePrefixes: ["openai:"],
  },
];
