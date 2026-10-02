import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

export function isSignalQuoteMetadataRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = normalizeLowercaseStringOrEmpty(message);
  const rpcCode = /^signal rpc (-?\d+):/u.exec(normalized)?.[1];
  if (rpcCode !== undefined) {
    if (rpcCode !== "-32602") {
      return false;
    }
  } else {
    const restStatusText = /^signal rest (\d{3}):/u.exec(normalized)?.[1];
    if (!restStatusText) {
      return false;
    }
    const restStatus = Number(restStatusText);
    // Only a definitive provider rejection makes replaying the send safe.
    if (restStatus < 400 || restStatus >= 500 || restStatus === 408 || restStatus === 429) {
      return false;
    }
  }
  if (!normalized.includes("quote")) {
    return false;
  }
  return (
    normalized.includes("reject") ||
    normalized.includes("invalid") ||
    normalized.includes("unrecognized") ||
    normalized.includes("unsupported") ||
    normalized.includes("not found") ||
    normalized.includes("no such") ||
    normalized.includes("unknown")
  );
}
