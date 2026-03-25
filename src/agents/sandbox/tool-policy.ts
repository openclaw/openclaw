import type { OpenClawConfig } from "../../config/config.js";
import {
  isToolAllowedBySandboxToolPolicy,
  resolveEffectiveSandboxToolPolicyForAgent,
} from "../tool-policy-sandbox.js";
import type { SandboxToolPolicy, SandboxToolPolicyResolved } from "./types.js";

export function isToolAllowed(policy: SandboxToolPolicy, name: string) {
  return isToolAllowedBySandboxToolPolicy(name, policy);
}

export function resolveSandboxToolPolicyForAgent(
  cfg?: OpenClawConfig,
  agentId?: string,
): SandboxToolPolicyResolved {
  return resolveEffectiveSandboxToolPolicyForAgent(cfg, agentId);
}
