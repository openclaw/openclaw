export function isSdkTerminalToolEventType(type: unknown): boolean {
  return type === "tool_execution_end" || type === "tool_result";
}
