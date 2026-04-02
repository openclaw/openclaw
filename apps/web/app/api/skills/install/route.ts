import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { discoverSkillsInRepo, parseSkillFrontmatter, readSkillsLock, selectSkillForSlug, writeSkillsLock } from "@/lib/skills";
import { resolveWorkspaceRoot } from "@/lib/workspace";

export const dynamic = "force-dynamic";

async function resolveDefaultBranch(source: string): Promise<string> {
  const repoResponse = await fetch(`https://api.github.com/repos/${source}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "DenchClaw Skill Installer",
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!repoResponse.ok) {
    throw new Error(`GitHub repo lookup failed: ${repoResponse.status} ${repoResponse.statusText}`);
  }

  const repo = await repoResponse.json() as { default_branch?: string };
  return repo.default_branch?.trim() || "main";
}

function resolveExtractedSkillDir(repoRoot: string, slug: string): string {
  const candidates = discoverSkillsInRepo(repoRoot);
  const result = selectSkillForSlug(candidates, slug);
  if (!result.skill) {
    throw new Error(result.reason);
  }
  return result.skill.dir;
}

export async function POST(req: Request) {
  let slug: string;
  let source: string;

  try {
    const body = await req.json() as { slug?: string; source?: string };
    const bodySlug = body.slug;
    const bodySource = body.source;
    if (typeof bodySlug !== "string" || typeof bodySource !== "string") {
      return Response.json({ ok: false, error: "Invalid request body" }, { status: 400 });
    }
    slug = bodySlug;
    source = bodySource;
  } catch {
    return Response.json({ ok: false, error: "Invalid request body" }, { status: 400 });
  }

  if (!slug || typeof slug !== "string" || /[/\\]/.test(slug) || slug === "." || slug === "..") {
    return Response.json({ ok: false, error: "Invalid skill slug" }, { status: 400 });
  }
  if (!source || typeof source !== "string" || !/^[^/]+\/[^/]+$/.test(source)) {
    return Response.json({ ok: false, error: "Invalid skill source" }, { status: 400 });
  }

  const workspaceRoot = resolveWorkspaceRoot();
  if (!workspaceRoot) {
    return Response.json({ ok: false, error: "Workspace root not found" }, { status: 500 });
  }

  const skillsDir = join(workspaceRoot, "skills");
  const targetDir = resolve(skillsDir, slug);
  if (!targetDir.startsWith(skillsDir + "/")) {
    return Response.json({ ok: false, error: "Invalid skill slug" }, { status: 400 });
  }

  const tempExtractDir = mkdtempSync(join(tmpdir(), "skills-sh-extract-"));

  try {
    const defaultBranch = await resolveDefaultBranch(source);
    const downloadUrl = `https://codeload.github.com/${source}/tar.gz/refs/heads/${encodeURIComponent(defaultBranch)}`;
    const res = await fetch(downloadUrl, {
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      return Response.json(
        { ok: false, error: `skills.sh download failed: ${res.status} ${res.statusText}` },
        { status: 502 },
      );
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    const tmpFile = join(tmpdir(), `skills-sh-${randomBytes(8).toString("hex")}.tar.gz`);
    writeFileSync(tmpFile, buffer);

    try {
      execFileSync("tar", ["-xzf", tmpFile, "-C", tempExtractDir], {
        stdio: "pipe",
        timeout: 15_000,
      });
    } finally {
      try { unlinkSync(tmpFile); } catch { /* ignore cleanup errors */ }
    }

    const extractedEntries = readdirSync(tempExtractDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory());
    const repoRoot = extractedEntries[0] ? join(tempExtractDir, extractedEntries[0].name) : undefined;
    if (!repoRoot) {
      throw new Error("Repository archive did not contain any files");
    }

    const extractedSkillDir = resolveExtractedSkillDir(repoRoot, slug);

    mkdirSync(skillsDir, { recursive: true });
    rmSync(targetDir, { recursive: true, force: true });
    mkdirSync(targetDir, { recursive: true });
    cpSync(extractedSkillDir, targetDir, { recursive: true, force: true });

    if (!existsSync(join(targetDir, "SKILL.md"))) {
      throw new Error("Installed skill is missing SKILL.md");
    }

    const skillFilePath = join(targetDir, "SKILL.md");
    const skillMetadata = parseSkillFrontmatter(readFileSync(skillFilePath, "utf-8"));
    const lock = readSkillsLock(workspaceRoot);
    lock[slug] = {
      slug,
      source,
      installedAt: new Date().toISOString(),
      installedFrom: "skills.sh",
    };
    writeSkillsLock(workspaceRoot, lock);

    return Response.json({
      ok: true,
      slug,
      path: targetDir,
      skill: {
        name: skillMetadata.name ?? slug,
        slug,
        description: skillMetadata.description ?? "",
        emoji: skillMetadata.emoji,
        source: "skills.sh",
        filePath: skillFilePath,
        protected: false,
      },
    });
  } catch (err) {
    return Response.json(
      { ok: false, error: `Install failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  } finally {
    try { rmSync(tempExtractDir, { recursive: true, force: true }); } catch { /* ignore cleanup errors */ }
  }
}
