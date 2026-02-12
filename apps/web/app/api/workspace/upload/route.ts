import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { resolveDenchRoot, safeResolveNewPath } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ALLOWED_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico",
]);

const MAX_SIZE = 10 * 1024 * 1024; // 10 MB

/**
 * POST /api/workspace/upload
 * Accepts multipart form data with a "file" field.
 * Saves to assets/<timestamp>-<filename> inside the workspace.
 * Returns { ok, path } where path is workspace-relative.
 */
export async function POST(req: Request) {
  const root = resolveDenchRoot();
  if (!root) {
    return Response.json(
      { error: "Workspace not found" },
      { status: 500 },
    );
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return Response.json({ error: "Invalid form data" }, { status: 400 });
  }

  const file = formData.get("file");
  if (!file || !(file instanceof File)) {
    return Response.json(
      { error: "Missing 'file' field" },
      { status: 400 },
    );
  }

  // Validate extension
  const ext = extname(file.name).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return Response.json(
      { error: `File type ${ext} is not allowed` },
      { status: 400 },
    );
  }

  // Validate size
  if (file.size > MAX_SIZE) {
    return Response.json(
      { error: "File is too large (max 10 MB)" },
      { status: 400 },
    );
  }

  // Build a safe filename: timestamp + sanitized original name
  const safeName = file.name
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_{2,}/g, "_");
  const relPath = join("assets", `${Date.now()}-${safeName}`);

  const absPath = safeResolveNewPath(relPath);
  if (!absPath) {
    return Response.json(
      { error: "Invalid path" },
      { status: 400 },
    );
  }

  try {
    mkdirSync(dirname(absPath), { recursive: true });
    const buffer = Buffer.from(await file.arrayBuffer());
    writeFileSync(absPath, buffer);
    return Response.json({ ok: true, path: relPath });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Upload failed" },
      { status: 500 },
    );
  }
}
