import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveOpenClawStateDir, resolveWorkspaceRoot } from "@/lib/workspace";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  if (!slug || /[/\\]/.test(slug) || slug === "." || slug === "..") {
    return Response.json({ error: "Invalid skill slug" }, { status: 400 });
  }

  const dirs: string[] = [];

  const workspaceRoot = resolveWorkspaceRoot();
  if (workspaceRoot) {
    dirs.push(join(workspaceRoot, "skills"));
  }

  const stateDir = resolveOpenClawStateDir();
  dirs.push(join(stateDir, "skills"));

  for (const dir of dirs) {
    const skillMd = resolve(dir, slug, "SKILL.md");
    if (!skillMd.startsWith(dir + "/")) continue;
    if (!existsSync(skillMd)) continue;

    try {
      const content = readFileSync(skillMd, "utf-8");
      return Response.json({ content });
    } catch {
      return Response.json({ error: "Failed to read skill content" }, { status: 500 });
    }
  }

  return Response.json({ error: "Skill not found" }, { status: 404 });
}
