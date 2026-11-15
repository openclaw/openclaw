import path from "node:path";

/** Local, filesystem-authorized WebSocket transport. Never a TCP fallback. */
export function parseUnixGatewayUrl(url: string): { socketPath: string; path: string } | undefined {
  if (!url.startsWith("ws+unix:")) {
    return undefined;
  }
  const separator = url.indexOf(":", "ws+unix:".length);
  const socketPath = url.slice("ws+unix:".length, separator);
  const requestPath = url.slice(separator + 1);
  if (
    separator < 0 ||
    !path.isAbsolute(socketPath) ||
    !requestPath.startsWith("/") ||
    /[\r\n\0?#]/u.test(socketPath)
  ) {
    throw new Error("invalid Unix Gateway URL");
  }
  return { socketPath, path: requestPath };
}
