import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

function isQuoteAuthorRejection(
  rawDetail: string,
  params: Record<string, unknown> | undefined,
  rest: boolean,
): boolean {
  let detail = rawDetail;
  if (rest) {
    try {
      const body: unknown = JSON.parse(detail);
      if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
        detail = body.error;
      }
    } catch {
      // Containers can also return plain text.
    }
  }
  if (
    detail === "Quote author parameter is missing" ||
    detail === "quote metadata rejected (redacted)"
  ) {
    return true;
  }
  const invalid = /^Invalid phone number '([^']+)':/u.exec(detail)?.[1];
  const author = params?.quoteAuthor;
  if (!invalid || typeof author !== "string") {
    return false;
  }
  const onWire = (value: unknown) =>
    typeof value === "string" && rest ? value.replace(/^uuid:/i, "") : value;
  const recipients = Array.isArray(params?.recipient) ? params.recipient : [params?.recipient];
  // The same parser rejects recipients too: only retry an unambiguous quote-author failure.
  return (
    invalid === onWire(author) &&
    ![params?.account, ...recipients].some((value) => onWire(value) === invalid)
  );
}

export function isSignalQuoteMetadataRejection(
  error: unknown,
  params?: Record<string, unknown>,
): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const authorFailure = /^Signal (RPC -1|REST 400):\s*([\s\S]*)$/u.exec(message);
  if (authorFailure) {
    const [, transport = "", detail = ""] = authorFailure;
    const rejected = isQuoteAuthorRejection(detail, params, transport === "REST 400");
    if (rejected || transport === "RPC -1" || detail.includes("Invalid phone number")) {
      return rejected;
    }
  }
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
