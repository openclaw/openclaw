import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "../api.js";
import { feedDataSearch } from "./feed-search-logic.js";
import type { FeedDataSearchRequest, FeedDataSearchResponse } from "./types.js";

const MAX_BODY_SIZE = 1_048_576; // 1 MB

/**
 * Parse the JSON body from an IncomingMessage with size limit.
 */
function parseBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on("data", (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_SIZE) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/**
 * Send a JSON response.
 */
function sendJson(res: ServerResponse, statusCode: number, body: FeedDataSearchResponse): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Register the POST /api/v1/feed/search HTTP route.
 */
export function registerFeedSearchHttpRoute(api: OpenClawPluginApi): void {
  api.registerHttpRoute({
    path: "/api/v1/feed/search",
    auth: "plugin",
    match: "exact",
    replaceExisting: true,
    async handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
      if (req.method !== "POST") {
        sendJson(res, 405, { success: false, error: "Method not allowed" });
        return;
      }

      let bodyStr: string;
      try {
        bodyStr = await parseBody(req);
      } catch {
        sendJson(res, 400, { success: false, error: "Failed to read request body" });
        return;
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(bodyStr);
      } catch {
        sendJson(res, 400, { success: false, error: "Invalid JSON body" });
        return;
      }

      // Validate required fields
      const userId = parsed.userId ?? parsed.user_id;
      if (!userId || typeof userId !== "string") {
        sendJson(res, 400, { success: false, error: "Missing or invalid userId" });
        return;
      }

      const request: FeedDataSearchRequest = {
        userId,
        itemId: typeof parsed.itemId === "number" ? parsed.itemId : (typeof parsed.item_id === "number" ? parsed.item_id : null),
        q: typeof parsed.q === "string" ? parsed.q : null,
        limit: Math.min(Math.max(Number(parsed.limit) || 50, 1), 500),
        offset: Math.max(Number(parsed.offset) || 0, 0),
      };

      const pluginConfig = api.pluginConfig as Record<string, unknown>;
      const runtime = api.runtime;
      const logger = api.logger;

      const result = await feedDataSearch(pluginConfig, runtime, logger, request);

      const statusCode = result.success ? 200 : 422;
      sendJson(res, statusCode, result);
    },
  });
}
