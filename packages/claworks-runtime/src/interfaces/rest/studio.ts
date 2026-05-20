import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const studioHtmlPath = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../../../studio/index.html",
);

let cachedHtml: string | null = null;

export async function serveClaworksStudio(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/studio" && url.pathname !== "/studio/") {
    return false;
  }
  if (!cachedHtml) {
    cachedHtml = await readFile(studioHtmlPath, "utf8");
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(cachedHtml);
  return true;
}
