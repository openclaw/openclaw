import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { DoctorSessionRouteStateOwner } from "openclaw/plugin-sdk/runtime-doctor";

// Mirrors extensions/claude/doctor-contract-api.ts. Provides legacy-config
// migration rules and session-route ownership metadata that openclaw doctor
// consumes via the plugin doctor-contract registry (loaded from this plugin's
// rootDir by src/plugins/doctor-contract-registry.ts).
//
// glm-bridge reuses the Claude extension's claude-bridge harness pointed at
// Z.ai, but it is its OWN plugin with its OWN provider identity ("zai"), so it
// needs its OWN doctor contract: sharing the Claude entry would let openclaw
// doctor mis-attribute orphaned GLM sessions to the Claude extension (GLM
// review G6). This file also gives glm-bridge a registered home for future
// zai-scoped legacy-config migrations without restructuring — the same reason
// the Claude extension pins an (empty) rules surface up front.

type LegacyConfigRule = {
  path: string[];
  message: string;
  match: (value: unknown) => boolean;
};

export const legacyConfigRules: LegacyConfigRule[] = [];

export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  return { config: cfg, changes: [] };
}

// Claims session keys whose provider identity or auth profile belongs to the
// GLM (Z.ai) harness. openclaw doctor uses this to attribute orphaned session
// state to glm-bridge instead of the Claude extension.
//
// Discriminates purely on the "zai" provider id and "zai:" auth-profile prefix
// — NOT on the "claude-bridge" runtimeId. GLM turns do run on the shared
// claude-bridge runtime, but that id is the Claude extension's; claiming it
// here would double-attribute every claude-bridge session to both owners.
// Every GLM session instead carries the "zai" provider in its model ref (or a
// "zai:" auth profile), so provider/auth attribution is unambiguous and
// non-overlapping with the Claude owner.
//
// runtimeIds / cliSessionKeys are OMITTED (left undefined), not set to []: the
// doctor-contract registry's owner validator rejects any owner carrying an
// empty-array field (normalizeTrimmedStringList([]) → length 0 fails the
// "=== undefined || length > 0" guard in doctor-contract-registry.ts), which
// would silently drop this entire owner from the scan.
export const sessionRouteStateOwners: DoctorSessionRouteStateOwner[] = [
  {
    id: "glm-bridge",
    label: "GLM Bridge (Z.ai)",
    providerIds: ["zai"],
    authProfilePrefixes: ["zai:"],
  },
];
