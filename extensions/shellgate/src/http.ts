import type { IncomingMessage, ServerResponse } from "node:http";
import type { ShellgateCredentials } from "./credentials.js";

export const VERIFY_PATH = "/plugins/shellgate/verify";

/** Authentication facts for the proxy, never a Gateway operator scope or session. */
export async function verifyShellgateRequest(
  req: IncomingMessage,
  res: ServerResponse,
  credentials: ShellgateCredentials,
): Promise<boolean> {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.writeHead(405).end();
    return true;
  }
  try {
    const subject = await credentials.authenticate(req.headers.authorization);
    if (!subject) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="Shellgate"');
      res.writeHead(401).end();
      return true;
    }
    res.setHeader("X-Shellgate-User", subject);
    res.writeHead(204).end();
  } catch {
    // Storage/lifecycle unavailability must never become an authenticated response.
    // Do not log requests, bearer credentials, or store errors containing data.
    res.setHeader("Retry-After", "1");
    res.writeHead(503).end();
  }
  return true;
}
