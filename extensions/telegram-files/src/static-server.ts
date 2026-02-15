import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import fsAsync from "node:fs/promises";
import path from "node:path";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/**
 * Serve static assets from the dist/webapp/ directory.
 * Adds Telegram-friendly CSP headers so the page can load inside the
 * Telegram Mini App iframe.
 */
export async function serveStaticAsset(
  _req: IncomingMessage,
  res: ServerResponse,
  urlPath: string,
  distRoot: string,
): Promise<boolean> {
  // Default to index.html for root or SPA fallback
  const safePath = urlPath === "/" || urlPath === "" ? "/index.html" : urlPath;

  // Prevent directory traversal
  const resolved = path.resolve(distRoot, safePath.replace(/^\//, ""));
  if (!resolved.startsWith(distRoot.endsWith(path.sep) ? distRoot : distRoot + path.sep)) {
    res.statusCode = 403;
    res.end("Forbidden");
    return true;
  }

  // Resolve symlinks and re-verify
  let realPath: string;
  try {
    realPath = await fsAsync.realpath(resolved);
  } catch {
    // File doesn't exist — try SPA fallback
    const indexPath = path.join(distRoot, "index.html");
    try {
      await fsAsync.access(indexPath);
      return sendFile(res, indexPath, ".html");
    } catch {
      res.statusCode = 404;
      res.end("Not Found");
      return true;
    }
  }

  let distRootReal: string;
  try {
    distRootReal = await fsAsync.realpath(distRoot);
  } catch {
    res.statusCode = 500;
    res.end("Internal Server Error");
    return true;
  }

  if (
    !realPath.startsWith(distRootReal.endsWith(path.sep) ? distRootReal : distRootReal + path.sep)
  ) {
    res.statusCode = 403;
    res.end("Forbidden");
    return true;
  }

  try {
    const stat = await fsAsync.stat(realPath);
    if (stat.isDirectory()) {
      const indexPath = path.join(distRoot, "index.html");
      try {
        await fsAsync.access(indexPath);
        return sendFile(res, indexPath, ".html");
      } catch {
        res.statusCode = 404;
        res.end("Not Found");
        return true;
      }
    }
  } catch {
    res.statusCode = 404;
    res.end("Not Found");
    return true;
  }

  const ext = path.extname(realPath).toLowerCase();
  return sendFile(res, realPath, ext);
}

function sendFile(res: ServerResponse, filePath: string, ext: string): boolean {
  const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
  res.setHeader("Content-Type", contentType);
  // Allow Telegram to embed in iframe
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors https://web.telegram.org https://*.telegram.org",
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  // Immutable cache for hashed assets, short cache for html
  if (ext === ".html") {
    res.setHeader("Cache-Control", "no-cache");
  } else {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  }
  res.statusCode = 200;
  const stream = fs.createReadStream(filePath);
  stream.on("error", () => {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end("Internal Server Error");
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
  return true;
}
