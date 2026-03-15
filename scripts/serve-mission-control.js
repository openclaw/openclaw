import { createReadStream, statSync, existsSync } from "node:fs";
// Simple static file server for Mavis MC
import { createServer } from "node:http";
import { join, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const DIST = resolve(__dirname, "../dist/mission-control");
const PORT = 3001;

const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

const server = createServer((req, res) => {
  let filePath = join(DIST, req.url === "/" ? "index.html" : req.url);
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    filePath = join(DIST, "index.html"); // SPA fallback
  }
  const ext = extname(filePath);
  res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
  createReadStream(filePath).pipe(res);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Mavis MC running at http://127.0.0.1:${PORT}/`);
  console.log(`Connect with: http://127.0.0.1:${PORT}/?gwHost=127.0.0.1:18789&token=<your-token>`);
});
