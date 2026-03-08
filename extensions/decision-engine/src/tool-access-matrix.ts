export type ToolPolicyMode = "allowlist" | "denylist";

export type ToolAccessMatrix = {
  mode: ToolPolicyMode;
  entries: string[];
};

export function isToolAllowed(params: { matrix: ToolAccessMatrix; toolName: string }): boolean {
  const has = params.matrix.entries.includes(params.toolName);
  if (params.matrix.mode === "allowlist") {
    return has;
  }
  return !has;
}

