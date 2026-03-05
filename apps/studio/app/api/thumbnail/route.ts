import { promises as fs } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { resolveAppsRoot } from "@/lib/project-meta";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
};

const fallbackSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
<defs><linearGradient id="fallback" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0f172a"/><stop offset="100%" stop-color="#1d4ed8"/></linearGradient></defs>
<rect width="1280" height="720" fill="url(#fallback)"/>
<circle cx="1130" cy="120" r="210" fill="rgba(255,255,255,0.08)"/>
<circle cx="170" cy="640" r="290" fill="rgba(255,255,255,0.08)"/>
<text x="82" y="500" fill="#f8fafc" font-size="78" font-family="Inter, system-ui, sans-serif" font-weight="700">No Thumbnail</text>
<text x="86" y="568" fill="rgba(248,250,252,0.88)" font-size="34" font-family="Inter, system-ui, sans-serif">Remotion Forge</text>
</svg>`;

function isWithinPath(targetPath: string, basePath: string): boolean {
  const relative = path.relative(basePath, targetPath);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function hasTraversalPattern(value: string): boolean {
  return /(^|[\\/])\.\.([\\/]|$)/.test(value);
}

function fallbackResponse() {
  return new NextResponse(fallbackSvg, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=60",
    },
  });
}

export async function GET(request: NextRequest) {
  const app = request.nextUrl.searchParams.get("app");
  const file =
    request.nextUrl.searchParams.get("file") ?? "public/thumbnail.svg";

  if (!app || hasTraversalPattern(app) || hasTraversalPattern(file)) {
    return fallbackResponse();
  }

  let appsRoot: string;
  try {
    appsRoot = resolveAppsRoot();
  } catch {
    return fallbackResponse();
  }
  const appDir = path.resolve(appsRoot, app);
  const thumbnailPath = path.resolve(appDir, file);

  if (!isWithinPath(appDir, appsRoot) || !isWithinPath(thumbnailPath, appDir)) {
    return fallbackResponse();
  }

  const fileBuffer = await fs.readFile(thumbnailPath).catch(() => null);
  if (!fileBuffer) {
    return fallbackResponse();
  }

  const extension = path.extname(thumbnailPath).toLowerCase();
  const contentType = MIME_BY_EXT[extension] ?? "application/octet-stream";

  return new NextResponse(new Uint8Array(fileBuffer), {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=60",
      "Content-Disposition": `inline; filename="${path.basename(thumbnailPath)}"`,
    },
  });
}
