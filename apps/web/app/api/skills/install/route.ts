import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { resolveWorkspaceRoot } from "@/lib/workspace";

export const dynamic = "force-dynamic";

const CLAWHUB_BASE = "https://clawhub.ai/api/v1";

export async function POST(req: Request) {
  let slug: string;
  let version: string | undefined;

  try {
    const body = await req.json();
    slug = body.slug;
    version = body.version;
  } catch {
    return Response.json({ ok: false, error: "Invalid request body" }, { status: 400 });
  }

  if (!slug || typeof slug !== "string" || /[/\\]/.test(slug) || slug === "." || slug === "..") {
    return Response.json({ ok: false, error: "Invalid skill slug" }, { status: 400 });
  }

  const workspaceRoot = resolveWorkspaceRoot();
  if (!workspaceRoot) {
    return Response.json({ ok: false, error: "Workspace root not found" }, { status: 500 });
  }

  const skillsDir = join(workspaceRoot, "skills");
  const targetDir = join(skillsDir, slug);

  try {
    let downloadUrl = `${CLAWHUB_BASE}/download?slug=${encodeURIComponent(slug)}`;
    if (version) downloadUrl += `&version=${encodeURIComponent(version)}`;

    const res = await fetch(downloadUrl, {
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      return Response.json(
        { ok: false, error: `ClawHub download failed: ${res.status} ${res.statusText}` },
        { status: 502 },
      );
    }

    const buffer = Buffer.from(await res.arrayBuffer());

    // Write to a temp zip first, then extract into the workspace skill directory.
    const tmpFile = join(tmpdir(), `clawhub-${randomBytes(8).toString("hex")}.zip`);
    writeFileSync(tmpFile, buffer);

    mkdirSync(targetDir, { recursive: true });

    try {
      execFileSync("unzip", ["-o", tmpFile, "-d", targetDir], {
        stdio: "pipe",
        timeout: 15_000,
      });
    } finally {
      try { unlinkSync(tmpFile); } catch { /* ignore cleanup errors */ }
    }

    // Mirror installs in .clawhub/lock.json so the local workspace stays compatible
    // with ClawHub's expected metadata format.
    const lockDir = join(workspaceRoot, ".clawhub");
    const lockFile = join(lockDir, "lock.json");
    mkdirSync(lockDir, { recursive: true });

    let lock: Record<string, { slug: string; version?: string; installedAt: string }> = {};
    if (existsSync(lockFile)) {
      try { lock = JSON.parse(readFileSync(lockFile, "utf-8")); } catch { /* ignore bad lock */ }
    }
    lock[slug] = { slug, version, installedAt: new Date().toISOString() };
    writeFileSync(lockFile, JSON.stringify(lock, null, 2));

    return Response.json({ ok: true, slug, path: targetDir });
  } catch (err) {
    return Response.json(
      { ok: false, error: `Install failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
}
