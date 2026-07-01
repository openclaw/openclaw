import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { DoctorSessionRouteStateOwner } from "openclaw/plugin-sdk/runtime-doctor";

// Mirrors extensions/codex/doctor-contract-api.ts. Provides legacy-config
// migration rules and session-route ownership metadata that openclaw doctor
// consumes via loadBundledChannelDoctorContractApi.
//
// The claude harness is new — no retired config keys yet. Empty
// legacyConfigRules + no-op normalizeCompatibilityConfig pin the surface so
// future retirements have a registered home without restructuring.

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

// Claims session keys whose auth profile or runtime identifier belongs to the
// claude harness. openclaw doctor uses this to attribute orphaned session
// state to the right extension when checking for stale sessions.
export const sessionRouteStateOwners: DoctorSessionRouteStateOwner[] = [
  {
    id: "claude",
    label: "Claude",
    providerIds: ["anthropic", "claude"],
    runtimeIds: ["claude", "claude-bridge"],
    cliSessionKeys: [],
    authProfilePrefixes: ["anthropic:", "claude:"],
  },
];
