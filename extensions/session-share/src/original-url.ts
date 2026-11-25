import { parseControlUiSessionPath } from "openclaw/plugin-sdk/session-discussion";

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
  originalPath: string | undefined,
  basePath: unknown = "",
): string | undefined {
  if (
    !origin ||
    !originalPath ||
    typeof basePath !== "string" ||
    !/^(?:\/(?!\/)[^\s\\?#]*)?$/.test(basePath) ||
    !originalPath.startsWith("/chat/") ||
    /[\s\\?#]/.test(originalPath)
  ) {
    return undefined;
  }
  const route = parseControlUiSessionPath(originalPath);
  if (route?.kind !== "literal" || route.sessionKey !== threadId) {
    return undefined;
  }
  const path = `${basePath.replace(/\/$/, "")}${originalPath}`;
  // URL parsing must not rewrite the approved prefix or a source path's dot segments.
  const url = new URL(`${origin}${path}`);
  return url.origin === origin && url.pathname === path ? url.href : undefined;
}
