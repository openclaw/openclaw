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

const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_CODELOAD_ORIGIN = "https://codeload.github.com";

/** Conservative owner/repo segment; avoids SSRF/path smuggling in URL construction. */
const GITHUB_OWNER_REPO = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?\/[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;

function parseValidatedGitHubRepo(source: string): { owner: string; repo: string } | null {
  const normalized = source.trim();
  if (!GITHUB_OWNER_REPO.test(normalized)) {
    return null;
  }
  const slash = normalized.indexOf("/");
  const owner = normalized.slice(0, slash);
  const repo = normalized.slice(slash + 1);
  if (!owner || !repo || owner.includes("..") || repo.includes("..")) {
    return null;
  }
  return { owner, repo };
}

/** Refuse refs that could alter URL structure when used as a single path segment. */
function assertSafeGitDefaultBranch(branch: string): string {
  const t = branch.trim();
  if (!t || t.length > 255) {
    throw new Error("Invalid default branch from GitHub");
  }
  if (t.includes("..") || t.startsWith("/") || t.includes("\\") || /[\s#?@]/.test(t)) {
    throw new Error("Invalid default branch from GitHub");
  }
  if (!/^[a-zA-Z0-9/_.,[\]{}*^~:-]+$/.test(t)) {
    throw new Error("Invalid default branch from GitHub");
  }
  return t;
}

async function resolveDefaultBranch(owner: string, repo: string): Promise<string> {
  const repoUrl = new URL(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, GITHUB_API_ORIGIN);
  const repoResponse = await fetch(repoUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "DenchClaw Skill Installer",
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!repoResponse.ok) {
    throw new Error(`GitHub repo lookup failed: ${repoResponse.status} ${repoResponse.statusText}`);
  }

  const repoJson = await repoResponse.json() as { default_branch?: string };
  const raw = repoJson.default_branch?.trim() || "main";
  return assertSafeGitDefaultBranch(raw);
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
  const parsedSource = typeof source === "string" ? parseValidatedGitHubRepo(source) : null;
  if (!source || typeof source !== "string" || !parsedSource) {
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
    const defaultBranch = await resolveDefaultBranch(parsedSource.owner, parsedSource.repo);
    const archivePath =
      `/${encodeURIComponent(parsedSource.owner)}/${encodeURIComponent(parsedSource.repo)}`
      + `/tar.gz/refs/heads/${encodeURIComponent(defaultBranch)}`;
    const downloadUrl = new URL(archivePath, GITHUB_CODELOAD_ORIGIN);
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
