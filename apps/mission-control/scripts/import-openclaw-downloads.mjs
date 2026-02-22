#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const cwd = process.cwd();
const homeDir = process.env.HOME || "/Users/tg";
const downloadsDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(homeDir, "Downloads");
const outDir = path.join(cwd, "src", "community-catalog");

const ZIP_CANDIDATES = {
  openclawMain: ["openclaw-main.zip"],
  usecases: ["awesome-openclaw-usecases-main.zip"],
  skills: ["openclaw-skills-main.zip"],
};

function readDirSafe(dirPath) {
  try {
    return execFileSync("ls", ["-1", dirPath], { encoding: "utf8" })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function resolveZipPath(dirPath, names) {
  for (const name of names) {
    const candidate = path.join(dirPath, name);
    try {
      execFileSync("test", ["-f", candidate]);
      return candidate;
    } catch {
      // Continue searching.
    }
  }

  const allFiles = readDirSafe(dirPath);
  const fallback = allFiles.find((file) => {
    const lower = file.toLowerCase();
    if (!lower.endsWith(".zip")) {return false;}
    return names.some((name) => {
      const prefix = name.replace(/\.zip$/i, "").toLowerCase();
      return lower.includes(prefix);
    });
  });
  return fallback ? path.join(dirPath, fallback) : null;
}

function listZipEntries(zipPath) {
  const output = execFileSync("unzip", ["-Z1", zipPath], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function readZipEntry(zipPath, entryPath) {
  return execFileSync("unzip", ["-p", zipPath, entryPath], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function toSlug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function capitalize(word) {
  if (!word) {return word;}
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function prettyNameFromSlug(slug) {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => capitalize(part))
    .join(" ");
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function markdownToSimpleHtml(markdown) {
  const lines = markdown.replace(/\r/g, "").split("\n");
  const chunks = [];
  let listBuffer = [];

  function flushList() {
    if (listBuffer.length === 0) {return;}
    chunks.push(`<ul>${listBuffer.map((item) => `<li>${item}</li>`).join("")}</ul>`);
    listBuffer = [];
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushList();
      continue;
    }

    if (line.startsWith("# ")) {
      flushList();
      chunks.push(`<h3>${escapeHtml(line.slice(2).trim())}</h3>`);
      continue;
    }

    if (line.startsWith("## ")) {
      flushList();
      chunks.push(`<h4>${escapeHtml(line.slice(3).trim())}</h4>`);
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const item = line.replace(/^[-*]\s+/, "");
      listBuffer.push(escapeHtml(item));
      continue;
    }

    flushList();
    chunks.push(`<p>${escapeHtml(line)}</p>`);
  }

  flushList();
  return chunks.join("\n");
}

function stripMarkdown(value) {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function inferCategory(text) {
  const lower = text.toLowerCase();
  if (/agent|orchestr|swarm|multi-agent/.test(lower)) {return "agents";}
  if (/deploy|host|infrastructure|cloud|server/.test(lower)) {return "deployment";}
  if (/security|threat|auth|token|privacy/.test(lower)) {return "security";}
  if (/research|analysis|insight|report/.test(lower)) {return "research";}
  if (/workflow|automation|pipeline|schedule|ops/.test(lower)) {return "workflow";}
  if (/content|marketing|social|youtube/.test(lower)) {return "content";}
  return "productivity";
}

function scoreUsecase(text, filename) {
  const lower = text.toLowerCase();
  let score = 78;
  if (/multi-agent|orchestr|pipeline/.test(lower)) {score += 8;}
  if (/api|integration|automation|workflow/.test(lower)) {score += 5;}
  if (/security|reliability|monitoring/.test(lower)) {score += 4;}
  if (/dashboard|analytics|insight/.test(lower)) {score += 3;}
  if (/template|checklist|step-by-step/.test(lower)) {score += 2;}
  if (filename.includes("daily") || filename.includes("morning")) {score += 1;}
  return Math.max(65, Math.min(97, score));
}

function extractFirstDescription(markdown) {
  const normalized = markdown.replace(/\r/g, "");
  const { frontMatter, body } = parseFrontMatter(normalized);

  if (typeof frontMatter.description === "string" && frontMatter.description.trim()) {
    return stripMarkdown(frontMatter.description).slice(0, 260);
  }

  const lines = body.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {continue;}
    if (line.startsWith("#")) {continue;}
    if (line.startsWith("---")) {continue;}
    if (line.startsWith("```")) {continue;}
    return stripMarkdown(line).slice(0, 260);
  }
  return "";
}

function readMarkdownEntry(zipPath, entryPath) {
  try {
    return readZipEntry(zipPath, entryPath);
  } catch {
    return "";
  }
}

function parseFrontMatter(markdown) {
  const lines = markdown.split("\n");
  if (lines[0]?.trim() !== "---") {
    return {
      frontMatter: {},
      body: markdown,
    };
  }

  let endIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") {
      endIndex = i;
      break;
    }
  }

  if (endIndex <= 0) {
    return {
      frontMatter: {},
      body: markdown,
    };
  }

  const frontMatter = {};
  const fmLines = lines.slice(1, endIndex);
  for (const line of fmLines) {
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/);
    if (!match) {continue;}
    frontMatter[match[1].toLowerCase()] = match[2].trim().replace(/^["']|["']$/g, "");
  }

  return {
    frontMatter,
    body: lines.slice(endIndex + 1).join("\n"),
  };
}

function mapMarkdownEntryToUsecase({ zipPath, entry, source, sourceDetailPrefix, urlBase }) {
  const markdown = readMarkdownEntry(zipPath, entry);
  if (!markdown.trim()) {return null;}

  const base = path.basename(entry);
  const slug = toSlug(base.replace(/\.md$/i, ""));
  const headingMatch = markdown.match(/^#\s+(.+)$/m);
  const { body } = parseFrontMatter(markdown);
  const title = headingMatch?.[1]?.trim() || prettyNameFromSlug(slug);
  const plain = stripMarkdown(body || markdown);
  const summary = extractFirstDescription(markdown) || plain.slice(0, 280);
  const category = inferCategory(`${title} ${summary}`);
  const tags = Array.from(
    new Set(
      slug
        .split("-")
        .filter((part) => part.length > 2)
        .slice(0, 6)
    )
  );

  return {
    id: `community-usecase-${toSlug(`${source}-${slug}`)}`,
    slug,
    title,
    category,
    tags,
    rating: scoreUsecase(`${title} ${plain}`, base),
    summary,
    content: markdownToSimpleHtml(body || markdown),
    source,
    sourceDetail: `${sourceDetailPrefix}/${base}`,
    sourcePath: entry,
    url: `${urlBase}${entry.split("/").slice(1).join("/")}`,
  };
}

function buildUsecaseCatalog(usecasesZipPath, openclawMainZipPath) {
  const usecases = [];

  if (usecasesZipPath) {
    const entries = listZipEntries(usecasesZipPath).filter(
      (entry) => /\/usecases\/[^/]+\.md$/i.test(entry)
    );
    for (const entry of entries) {
      const parsed = mapMarkdownEntryToUsecase({
        zipPath: usecasesZipPath,
        entry,
        source: "awesome-openclaw-usecases",
        sourceDetailPrefix: "community/usecases",
        urlBase: "https://github.com/openclaw/awesome-openclaw-usecases/blob/main/",
      });
      if (parsed) {usecases.push(parsed);}
    }
  }

  if (openclawMainZipPath) {
    const playbookEntries = listZipEntries(openclawMainZipPath).filter((entry) =>
      /\/\.agent\/workflows\/[^/]+\.md$/i.test(entry) ||
      /\/\.agents\/skills\/PR_WORKFLOW\.md$/i.test(entry)
    );
    for (const entry of playbookEntries) {
      const parsed = mapMarkdownEntryToUsecase({
        zipPath: openclawMainZipPath,
        entry,
        source: "openclaw-main",
        sourceDetailPrefix: "community/playbooks",
        urlBase: "https://github.com/openclaw/openclaw/blob/main/",
      });
      if (parsed) {
        parsed.category = "workflow";
        parsed.rating = Math.max(parsed.rating, 90);
        usecases.push(parsed);
      }
    }
  }

  const sortedUsecases = usecases.toSorted((a, b) => b.rating - a.rating);

  return {
    generatedAt: new Date().toISOString(),
    sourceZips: [usecasesZipPath, openclawMainZipPath]
      .filter(Boolean)
      .map((item) => path.basename(item)),
    total: sortedUsecases.length,
    usecases: sortedUsecases,
  };
}

function collectSkillDocs(zipPath, entryPattern, sourceName, sourceUrlBase, categoryFromPath) {
  if (!zipPath) {return [];}
  const entries = listZipEntries(zipPath).filter((entry) => entryPattern.test(entry));
  return entries.map((entry) => {
    const markdown = readMarkdownEntry(zipPath, entry);
    const folderName = path.basename(path.dirname(entry));
    const name = prettyNameFromSlug(folderName);
    const description = extractFirstDescription(markdown) || "Skill documentation";
    return {
      id: `community-skill-${toSlug(`${sourceName}-${folderName}`)}`,
      slug: folderName,
      name,
      description,
      category: categoryFromPath(entry, folderName),
      tags: folderName.split("-").filter((part) => part.length > 2).slice(0, 6),
      source: sourceName,
      sourcePath: entry,
      url: `${sourceUrlBase}${entry.split("/").slice(1).join("/")}`,
      scriptsCount: 0,
      referencesCount: 0,
    };
  });
}

function attachSkillAssets(skills, zipPath, sourcePrefix) {
  if (!zipPath || skills.length === 0) {return skills;}
  const entries = listZipEntries(zipPath);

  const bySkill = new Map(skills.map((skill) => [skill.sourcePath, skill]));
  for (const entry of entries) {
    if (entry.endsWith("/")) {continue;}
    const owner = skills.find((skill) => entry.startsWith(path.dirname(skill.sourcePath) + "/"));
    if (!owner) {continue;}
    if (/\/scripts\/[^/]+$/i.test(entry)) {owner.scriptsCount += 1;}
    if (/\/references\/[^/]+$/i.test(entry)) {owner.referencesCount += 1;}
  }

  return skills.map((skill) => {
    const next = bySkill.get(skill.sourcePath);
    if (!next) {return skill;}
    return {
      ...next,
      source: sourcePrefix,
    };
  });
}

function buildSkillCatalog(skillsZipPath, openclawMainZipPath) {
  const communitySkills = collectSkillDocs(
    skillsZipPath,
    /\/[^/]+\/SKILL\.md$/i,
    "openclaw-skills-pack",
    "https://github.com/openclaw/openclaw-skills/blob/main/",
    (_entry, folderName) => {
      if (["bankr", "clanker", "erc-8004", "zapper", "qrcoin"].includes(folderName)) {
        return "crypto";
      }
      if (["base", "botchan", "onchainkit", "veil"].includes(folderName)) {
        return "developer-tools";
      }
      return "integration";
    }
  );

  const officialWorkflowSkills = collectSkillDocs(
    openclawMainZipPath,
    /\/\.agents\/skills\/[^/]+\/SKILL\.md$/i,
    "openclaw-main",
    "https://github.com/openclaw/openclaw/blob/main/",
    () => "workflow"
  );

  const skillItems = [
    ...attachSkillAssets(communitySkills, skillsZipPath, "openclaw-skills-pack"),
    ...officialWorkflowSkills,
  ].toSorted((a, b) => a.name.localeCompare(b.name));

  return {
    generatedAt: new Date().toISOString(),
    sourceZips: [skillsZipPath, openclawMainZipPath]
      .filter(Boolean)
      .map((item) => path.basename(item)),
    total: skillItems.length,
    skills: skillItems,
  };
}

async function main() {
  const resolved = {
    openclawMain: resolveZipPath(downloadsDir, ZIP_CANDIDATES.openclawMain),
    usecases: resolveZipPath(downloadsDir, ZIP_CANDIDATES.usecases),
    skills: resolveZipPath(downloadsDir, ZIP_CANDIDATES.skills),
  };

  await fs.mkdir(outDir, { recursive: true });

  const usecaseCatalog = buildUsecaseCatalog(resolved.usecases, resolved.openclawMain);
  const skillCatalog = buildSkillCatalog(resolved.skills, resolved.openclawMain);

  await fs.writeFile(
    path.join(outDir, "usecases.json"),
    `${JSON.stringify(usecaseCatalog, null, 2)}\n`,
    "utf8"
  );
  await fs.writeFile(
    path.join(outDir, "skills.json"),
    `${JSON.stringify(skillCatalog, null, 2)}\n`,
    "utf8"
  );

  console.log(
    JSON.stringify(
      {
        downloadsDir,
        resolvedZips: Object.fromEntries(
          Object.entries(resolved).map(([key, value]) => [key, value ? path.basename(value) : null])
        ),
        outputs: {
          usecases: path.join("src", "community-catalog", "usecases.json"),
          skills: path.join("src", "community-catalog", "skills.json"),
        },
        counts: {
          usecases: usecaseCatalog.total,
          skills: skillCatalog.total,
        },
      },
      null,
      2
    )
  );
}

await main();
