export function isTransientOpenAIResponsesReasoningItem(item: unknown): boolean {
  if (!item || typeof item !== "object") {
    return false;
  }
  const record = item as { type?: unknown; id?: unknown };
  return (
    record.type === "reasoning" && typeof record.id === "string" && record.id.startsWith("rs_tmp_")
  );
}
