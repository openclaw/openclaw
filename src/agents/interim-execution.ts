const INTERIM_EXECUTION_HINTS = [
  "on it",
  "pulling everything together",
  "give me a few",
  "give me a few min",
  "few minutes",
  "let me compile",
  "i'll gather",
  "i will gather",
  "working on it",
  "retrying now",
  "auto-announce when done",
  "我继续处理",
  "我继续执行",
  "我来继续执行",
  "我先处理一下",
  "处理中",
  "完成后回报",
  "完成后同步",
] as const;

function normalizeInterimExecutionText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function isLikelyInterimExecutionMessage(value: string): boolean {
  const normalized = normalizeInterimExecutionText(value);
  if (!normalized) {
    return false;
  }
  const words = normalized.split(" ").filter(Boolean).length;
  return words <= 45 && INTERIM_EXECUTION_HINTS.some((hint) => normalized.includes(hint));
}
