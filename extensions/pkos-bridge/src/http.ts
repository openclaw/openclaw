import type { IncomingMessage, ServerResponse } from "node:http";
import type { ResolvedPkosBridgeConfig } from "./config.js";
import { buildBridgeStatusText } from "./shared.js";

function writeJson(res: ServerResponse, statusCode: number, body: unknown): boolean {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(`${JSON.stringify(body, null, 2)}\n`);
  return true;
}

export function createPkosBridgeHttpHandler(config: ResolvedPkosBridgeConfig) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const requestUrl = req.url ?? "";
    const basePath = config.http.basePath;
    const normalizedPath = requestUrl.split("?")[0] ?? "";

    if (req.method === "GET" && normalizedPath === `${basePath}/health`) {
      return writeJson(res, 200, {
        ok: true,
        plugin: "pkos-bridge",
        status: "scaffold-ready",
        basePath,
      });
    }

    if (req.method === "GET" && normalizedPath === `${basePath}/status`) {
      return writeJson(res, 200, {
        ok: true,
        plugin: "pkos-bridge",
        text: buildBridgeStatusText(config),
      });
    }

    return writeJson(res, 404, {
      ok: false,
      error: "not_found",
      plugin: "pkos-bridge",
      path: normalizedPath,
    });
  };
}
