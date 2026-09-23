import { buildControlUiSessionPath } from "openclaw/plugin-sdk/session-discussion";
import { sessionShareSourceSession } from "./thread-id.js";

/** Only the receiver may select a source origin; never infer it from a node address. */
export function sessionShareControlUiOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^https?:\/\/[^/]+\/?$/.test(value) || /[\s\\?#]/.test(value)) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return !url.username && !url.password && url.pathname === "/" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

export function sessionShareOriginalUrl(
  origin: string | undefined,
  threadId: string,
): string | undefined {
  if (!origin) {
    return undefined;
  }
  const path = buildControlUiSessionPath({
    namespace: "chat",
    ...sessionShareSourceSession(threadId),
    exactKey: true,
  });
  return path ? `${origin}${path}` : undefined;
}
