import type { IncomingMessage, ServerResponse } from "node:http";
import type { PluginLogger } from "openclaw/plugin-sdk";
import type { DiffArtifactStore } from "./store.js";
import { DIFF_ARTIFACT_ID_PATTERN, DIFF_ARTIFACT_TOKEN_PATTERN } from "./types.js";
import { VIEWER_ASSET_PREFIX, getServedViewerAsset } from "./viewer-assets.js";

const VIEW_PREFIX = "/plugins/diffs/view/";
const VIEWER_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
  "object-src 'none'",
].join("; ");

export function createDiffsHttpHandler(params: {
  store: DiffArtifactStore;
  logger?: PluginLogger;
}) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const parsed = parseRequestUrl(req.url);
    if (!parsed) {
      return false;
    }

    if (parsed.pathname.startsWith(VIEWER_ASSET_PREFIX)) {
      return await serveAsset(req, res, parsed.pathname, params.logger);
    }

    if (!parsed.pathname.startsWith(VIEW_PREFIX)) {
      return false;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      respondText(res, 405, "Method not allowed");
      return true;
    }

    const pathParts = parsed.pathname.split("/").filter(Boolean);
    const id = pathParts[3];
    const token = pathParts[4];
    if (
      !id ||
      !token ||
      !DIFF_ARTIFACT_ID_PATTERN.test(id) ||
      !DIFF_ARTIFACT_TOKEN_PATTERN.test(token)
    ) {
      respondText(res, 404, "Diff not found");
      return true;
    }

    const artifact = await params.store.getArtifact(id, token);
    if (!artifact) {
      respondText(res, 404, "Diff not found or expired");
      return true;
    }

    try {
      const html = await params.store.readHtml(id);
      res.statusCode = 200;
      setSharedHeaders(res, "text/html; charset=utf-8");
      res.setHeader("content-security-policy", VIEWER_CONTENT_SECURITY_POLICY);
      if (req.method === "HEAD") {
        res.end();
      } else {
        res.end(html);
      }
      return true;
    } catch (error) {
      params.logger?.warn(`Failed to serve diff artifact ${id}: ${String(error)}`);
      respondText(res, 500, "Failed to load diff");
      return true;
    }
  };
}

function parseRequestUrl(rawUrl?: string): URL | null {
  if (!rawUrl) {
    return null;
  }
  try {
    return new URL(rawUrl, "http://127.0.0.1");
  } catch {
    return null;
  }
}

async function serveAsset(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  logger?: PluginLogger,
): Promise<boolean> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    respondText(res, 405, "Method not allowed");
    return true;
  }

  try {
    const asset = await getServedViewerAsset(pathname);
    if (!asset) {
      respondText(res, 404, "Asset not found");
      return true;
    }

    res.statusCode = 200;
    setSharedHeaders(res, asset.contentType);
    if (req.method === "HEAD") {
      res.end();
    } else {
      res.end(asset.body);
    }
    return true;
  } catch (error) {
    logger?.warn(`Failed to serve diffs asset ${pathname}: ${String(error)}`);
    respondText(res, 500, "Failed to load asset");
    return true;
  }
}

function respondText(res: ServerResponse, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  setSharedHeaders(res, "text/plain; charset=utf-8");
  res.end(body);
}

function setSharedHeaders(res: ServerResponse, contentType: string): void {
  res.setHeader("cache-control", "no-store, max-age=0");
  res.setHeader("content-type", contentType);
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
}
