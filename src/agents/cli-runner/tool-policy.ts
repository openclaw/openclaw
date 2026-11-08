import { normalizeToolPolicyName } from "../tool-policy.js";

/** Match provider-native names against the canonical tool hook and policy ids. */
export function normalizeCliToolName(toolName: string): string {
  return normalizeToolPolicyName(
    toolName.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").replace(/([a-z0-9])([A-Z])/g, "$1_$2"),
  );
}

/** Keeps only explicit runtime caps for backend-owned exact translation. */
export function resolveCliRuntimeToolsAllow(toolsAllow?: string[]): string[] | undefined {
  if (toolsAllow === undefined) {
    return undefined;
  }
  return toolsAllow.some((toolName) => normalizeToolPolicyName(toolName) === "*")
    ? undefined
    : toolsAllow;
}
