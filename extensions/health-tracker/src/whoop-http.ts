import type { IncomingMessage, ServerResponse } from "node:http";
import type { WhoopClient } from "./whoop-api.js";

/** HTTP handler for the Whoop OAuth callback route. */
export function createWhoopHttpHandler(whoop: WhoopClient) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    // Only handle the callback path
    if (pathname !== "/plugins/health-tracker/whoop/callback") {
      return false;
    }

    const code = url.searchParams.get("code");
    if (!code) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end("<h1>Error</h1><p>No authorization code received from Whoop.</p>");
      return true;
    }

    const tokens = await whoop.exchangeCode(code);
    if (!tokens) {
      res.writeHead(500, { "Content-Type": "text/html" });
      res.end(
        "<h1>Error</h1><p>Failed to exchange authorization code for tokens. Check your client credentials.</p>",
      );
      return true;
    }

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      "<h1>Whoop Connected</h1>" +
        "<p>Your Whoop account has been successfully connected to the Health Tracker.</p>" +
        "<p>You can close this tab and return to Discord/Telegram.</p>" +
        '<p>Try asking: <em>"Show me my sleep data"</em> or <em>"What\'s my recovery score?"</em></p>',
    );
    return true;
  };
}
