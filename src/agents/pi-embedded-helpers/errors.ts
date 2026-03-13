export function isToolUseIdMismatchError(raw: string): boolean {
  if (!raw) return false;
  const lower = raw.toLowerCase();
  return (
    lower.includes("tool_use_id") &&
    (lower.includes("does not match") || lower.includes("mismatch"))
  );
}

export function formatAssistantErrorText(
