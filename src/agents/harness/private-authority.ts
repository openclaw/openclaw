import { isBuiltinOpenClawAgentHarness } from "./builtin-openclaw-identity.js";
import { getRegisteredAgentHarness } from "./registry.js";
import type { AgentHarness } from "./types.js";

const BUNDLED_LIFECYCLE_RESET_HARNESS_OWNERS: ReadonlyMap<string, string> = new Map([
  ["codex", "codex"],
  ["copilot", "copilot"],
]);

export function harnessOwnsPrivateLifecycleResetAuthority(harness: AgentHarness): boolean {
  if (isBuiltinOpenClawAgentHarness(harness)) {
    return true;
  }
  const expectedOwner = BUNDLED_LIFECYCLE_RESET_HARNESS_OWNERS.get(harness.id);
  if (!expectedOwner) {
    return false;
  }
  const registered = getRegisteredAgentHarness(harness.id);
  return registered?.harness === harness && registered.ownerPluginId === expectedOwner;
}
