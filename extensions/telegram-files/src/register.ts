import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  handleDelete,
  handleExchange,
  handleHome,
  handleLs,
  handleMkdir,
  handleRead,
  handleSearch,
  handleUpload,
  handleWrite,
} from "./api-handlers.js";
import { checkAuth, jsonResponse } from "./auth.js";
import { createPairingCode } from "./pairing.js";
import { getFilesRuntime } from "./runtime.js";
import { serveStaticAsset } from "./static-server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_WEBAPP = path.resolve(__dirname, "..", "dist", "webapp");

export type TelegramFilesPluginConfig = {
  externalUrl?: string;
  allowedPaths?: string[];
};

export function registerAll(api: OpenClawPluginApi) {
  const raw = api.pluginConfig as Record<string, unknown> | undefined;
  const pluginConfig: TelegramFilesPluginConfig = {
    externalUrl: typeof raw?.externalUrl === "string" ? raw.externalUrl : undefined,
    allowedPaths: Array.isArray(raw?.allowedPaths)
      ? (raw.allowedPaths as unknown[]).filter((p): p is string => typeof p === "string")
      : [],
  };
  const allowedPaths = pluginConfig.allowedPaths ?? [];

  // Derive CORS origin from externalUrl (deny cross-origin when unconfigured or malformed)
  let corsOrigin = "null";
  if (pluginConfig.externalUrl) {
    try {
      const parsed = new URL(pluginConfig.externalUrl);
      corsOrigin = parsed.origin;
    } catch {
      // Malformed URL — keep "null" to deny cross-origin requests
    }
  }

  // 1. Register /files command
  api.registerCommand({
    name: "files",
    description: "Open file manager on mobile (optional: /files /path/to/dir)",
    acceptsArgs: true,
    handler: async (ctx) => {
      const cfg = ctx.config;
      const externalUrl = pluginConfig.externalUrl;

      if (!externalUrl) {
        return {
          text: 'Please set externalUrl: openclaw config set plugins.entries.telegram-files.config.externalUrl "https://your-host"',
        };
      }

      const gatewayToken = cfg.gateway?.auth?.token;
      if (!gatewayToken) {
        return {
          text: "Gateway auth token not found. Set gateway.auth.token in config.",
        };
      }

      const code = createPairingCode();

      // Build Mini App URL with optional start path
      const startPath = ctx.args?.trim() || "";
      let miniAppUrl = `${externalUrl}/plugins/telegram-files/?pair=${code}`;
      if (startPath) {
        miniAppUrl += `&path=${encodeURIComponent(startPath)}`;
      }

      if (ctx.channel === "telegram" && ctx.senderId) {
        const runtime = getFilesRuntime();
        const { token } = runtime.channel.telegram.resolveTelegramToken(cfg);
        if (token) {
          try {
            const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: ctx.senderId,
                text: "Tap to open file manager:",
                reply_markup: {
                  inline_keyboard: [
                    [
                      {
                        text: "Open File Manager",
                        web_app: { url: miniAppUrl },
                      },
                    ],
                  ],
                },
              }),
            });
            if (resp.ok) {
              return { text: "" };
            }
          } catch {
            // Fall through to text fallback
          }
        }
      }

      return { text: `Open file manager: ${miniAppUrl}` };
    },
  });

  // 2. Register HTTP handler
  api.registerHttpHandler(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const prefix = "/plugins/telegram-files";

    if (!url.pathname.startsWith(prefix)) {
      return false;
    }

    const subPath = url.pathname.slice(prefix.length) || "/";

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Origin", corsOrigin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.statusCode = 204;
      res.end();
      return true;
    }

    // Token exchange (no auth required)
    if (req.method === "POST" && subPath === "/api/exchange") {
      await handleExchange(req, res, corsOrigin);
      return true;
    }

    // All other API endpoints require auth
    if (subPath.startsWith("/api/")) {
      if (!checkAuth(req)) {
        jsonResponse(res, 401, { error: "unauthorized" }, corsOrigin);
        return true;
      }

      if (req.method === "GET" && subPath === "/api/home") {
        handleHome(res, allowedPaths, corsOrigin);
      } else if (req.method === "GET" && subPath === "/api/ls") {
        await handleLs(url, res, allowedPaths, corsOrigin);
      } else if (req.method === "GET" && subPath === "/api/read") {
        await handleRead(url, res, allowedPaths, corsOrigin);
      } else if (req.method === "POST" && subPath === "/api/write") {
        await handleWrite(req, res, allowedPaths, corsOrigin);
      } else if (req.method === "POST" && subPath === "/api/upload") {
        await handleUpload(req, url, res, allowedPaths, corsOrigin);
      } else if (req.method === "POST" && subPath === "/api/mkdir") {
        await handleMkdir(req, res, allowedPaths, corsOrigin);
      } else if (req.method === "DELETE" && subPath === "/api/delete") {
        await handleDelete(req, url, res, allowedPaths, corsOrigin);
      } else if (req.method === "GET" && subPath === "/api/search") {
        await handleSearch(url, res, allowedPaths, corsOrigin);
      } else {
        jsonResponse(res, 404, { error: "unknown API endpoint" }, corsOrigin);
      }
      return true;
    }

    // Static assets (GET)
    if (req.method === "GET") {
      return await serveStaticAsset(req, res, subPath, DIST_WEBAPP);
    }

    return false;
  });
}
