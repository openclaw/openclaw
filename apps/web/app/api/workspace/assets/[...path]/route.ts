import { readFileSync, existsSync } from "node:fs";
import { extname } from "node:path";
import { safeResolvePath } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MIME_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
};

/**
 * GET /api/workspace/assets/<path>
 * Serves an image file from the workspace's assets/ directory.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const segments = (await params).path;
  if (!segments || segments.length === 0) {
    return new Response("Not found", { status: 404 });
  }

  const relPath = "assets/" + segments.join("/");
  const ext = extname(relPath).toLowerCase();

  // Only serve known image types
  const mime = MIME_MAP[ext];
  if (!mime) {
    return new Response("Unsupported file type", { status: 400 });
  }

  const absPath = safeResolvePath(relPath);
  if (!absPath || !existsSync(absPath)) {
    return new Response("Not found", { status: 404 });
  }

  try {
    const buffer = readFileSync(absPath);
    return new Response(buffer, {
      headers: {
        "Content-Type": mime,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return new Response("Read error", { status: 500 });
  }
}
