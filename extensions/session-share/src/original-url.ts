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
  basePath: unknown = "",
): string | undefined {
  if (!origin || typeof basePath !== "string" || !/^(?:\/(?!\/)[^\s\\?#]*)?$/.test(basePath)) {
    return undefined;
  }
  const path = buildControlUiSessionPath({
    namespace: "chat",
    basePath,
    ...sessionShareSourceSession(threadId),
    exactKey: true,
    literalKey: true,
  });
  // URL parsing must not rewrite the approved prefix (for example, dot segments).
  return path && new URL(`${origin}${path}`).pathname === path ? `${origin}${path}` : undefined;
}
