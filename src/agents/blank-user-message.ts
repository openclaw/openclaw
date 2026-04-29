export type BlankUserContentRepair =
  | { kind: "keep" }
  | { kind: "rewrite"; content: unknown }
  | { kind: "drop" };

export function repairBlankUserMessageContent(content: unknown): BlankUserContentRepair {
  if (typeof content === "string") {
    return content.trim() ? { kind: "keep" } : { kind: "drop" };
  }
  if (!Array.isArray(content)) {
    return { kind: "keep" };
  }

  let touched = false;
  const next = content.filter((block) => {
    if (!block || typeof block !== "object") {
      return true;
    }
    if ((block as { type?: unknown }).type !== "text") {
      return true;
    }
    const text = (block as { text?: unknown }).text;
    if (typeof text !== "string" || text.trim().length > 0) {
      return true;
    }
    touched = true;
    return false;
  });
  if (next.length === 0) {
    return { kind: "drop" };
  }
  if (!touched) {
    return { kind: "keep" };
  }
  return { kind: "rewrite", content: next };
}

export function dropBlankUserMessages<T extends { role?: unknown; content?: unknown }>(
  messages: readonly T[],
): { messages: T[]; droppedCount: number } {
  let droppedCount = 0;
  let touched = false;
  const out: T[] = [];
  for (const msg of messages) {
    if (!msg || msg.role !== "user") {
      out.push(msg);
      continue;
    }
    const result = repairBlankUserMessageContent(msg.content);
    if (result.kind === "drop") {
      droppedCount += 1;
      touched = true;
      continue;
    }
    if (result.kind === "rewrite") {
      touched = true;
      out.push({ ...(msg as Record<string, unknown>), content: result.content } as T);
      continue;
    }
    out.push(msg);
  }
  return { messages: touched ? out : (messages as T[]), droppedCount };
}
