import { expandToolGroups, normalizeToolPolicyName } from "./tool-policy.js";

export function runtimeToolAllowlistIncludesMessage(toolNames: string[]): boolean {
  return expandToolGroups(toolNames).some((toolName) => {
    const normalized = normalizeToolPolicyName(toolName);
    return normalized === "*" || normalized === "message";
  });
}
