import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { removeSkillsLockEntry } from "@/lib/skills";
import { resolveWorkspaceRoot } from "@/lib/workspace";

export const dynamic = "force-dynamic";

const PROTECTED_SKILLS = ["crm", "browser", "app-builder", "gstack", "dench-integrations"];

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  // Only allow plain skill slugs so a delete cannot escape the workspace/skills dir.
  if (!slug || /[/\\]/.test(slug) || slug === "." || slug === "..") {
    return Response.json({ ok: false, error: "Invalid skill slug" }, { status: 400 });
  }

  // Managed DenchClaw skills are required for core behavior and must stay installed.
  if (PROTECTED_SKILLS.includes(slug)) {
    return Response.json(
      { ok: false, error: "This skill is required by DenchClaw and cannot be removed" },
      { status: 403 },
    );
  }

  const workspaceRoot = resolveWorkspaceRoot();
  if (!workspaceRoot) {
    return Response.json({ ok: false, error: "Workspace root not found" }, { status: 500 });
  }

  const skillsDir = join(workspaceRoot, "skills");
  const skillDir = resolve(skillsDir, slug);
  if (!skillDir.startsWith(skillsDir + "/")) {
    return Response.json({ ok: false, error: "Invalid skill slug" }, { status: 400 });
  }
  if (!existsSync(skillDir)) {
    return Response.json({ ok: false, error: "Skill not found" }, { status: 404 });
  }

  try {
    await rm(skillDir, { recursive: true, force: true });
    removeSkillsLockEntry(workspaceRoot, slug);
    return Response.json({ ok: true, slug });
  } catch (err) {
    return Response.json(
      { ok: false, error: `Failed to remove skill: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
}
