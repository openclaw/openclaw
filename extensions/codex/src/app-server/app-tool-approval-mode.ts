export type CodexAppToolApprovalMode = "auto" | "prompt" | "writes" | "approve";

export function normalizeAppToolApprovalMode(value: unknown): CodexAppToolApprovalMode | undefined {
  return value === "auto" || value === "prompt" || value === "writes" || value === "approve"
    ? value
    : undefined;
}
