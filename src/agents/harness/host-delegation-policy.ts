import { createRuntimeConfigReader } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getPreparedModelRuntimePolicyConfigReader } from "../prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeSnapshot } from "../prepared-model-runtime.types.js";

/** Capture the admitted reader before async tool preparation; explicit plugin configs stay scoped. */
export function captureHostDelegationPolicy(
  attempt: { config?: OpenClawConfig; preparedModelRuntime?: PreparedModelRuntimeSnapshot },
  requiresWorkspace: () => boolean,
): (options: { config?: OpenClawConfig }) => (() => OpenClawConfig) | undefined {
  const policyConfig = attempt.config;
  const readPolicyConfig =
    getPreparedModelRuntimePolicyConfigReader(attempt.preparedModelRuntime) ??
    (policyConfig ? createRuntimeConfigReader(policyConfig) : undefined);
  return (options) =>
    requiresWorkspace() || !options.config || options.config === policyConfig
      ? readPolicyConfig
      : createRuntimeConfigReader(options.config);
}
