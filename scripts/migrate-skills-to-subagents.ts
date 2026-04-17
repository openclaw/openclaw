#!/usr/bin/env node
// Convert OpenClaw SKILL.md files into Claude Code sub-agent .md files.
//
// Reads every `<root>/<skill-name>/SKILL.md` and writes a sub-agent under
// `.claude/agents/<skill-name>.md` with the frontmatter flattened to the
// `name`/`description`/`tools` shape Claude Code expects, plus a rendered
// "## Requirements" section derived from `metadata.openclaw.{requires,install,os}`.
//
// Design constraints (see plans/proud-roaming-lollipop.md Phase 1):
//   * Output is byte-stable: re-running produces identical files. This matters
//     for prompt-cache stability upstream — regenerations must not perturb
//     cached prefixes.
//   * The original SKILL.md files stay where they are; this writes an
//     additional artifact. The legacy loader at
//     `src/agents/skills/local-loader.ts` keeps working unchanged.
//   * Two modes:
//       --write   (default) regenerate .claude/agents/*.md
//       --check            regenerate into a tempdir, diff against repo; exit 1 on drift
//
// Run via the package scripts:
//   pnpm skills:subagents:gen
//   pnpm skills:subagents:check

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

// ---------- Types ----------

type SkillMetadataOpenclaw = {
  emoji?: string;
  os?: string[];
  requires?: {
    bins?: string[];
    config?: string[];
  };
  install?: Array<{
    id?: string;
    kind?: string;
    formula?: string;
    package?: string;
    label?: string;
    bins?: string[];
  }>;
};

type SkillFrontmatter = {
  name?: string;
  description?: string;
  homepage?: string;
  "allowed-tools"?: string[];
  metadata?: {
    openclaw?: SkillMetadataOpenclaw;
  };
};

type SubAgentWrite = {
  outputPath: string;
  content: string;
};

// ---------- Frontmatter extraction ----------

function extractFrontmatterRaw(source: string): { yaml: string; body: string } | null {
  const normalized = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) {
    return null;
  }
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) {
    return null;
  }
  const yaml = normalized.slice(4, endIndex);
  // Skip the closing "\n---" and any following newline.
  let bodyStart = endIndex + 4;
  if (normalized[bodyStart] === "\n") {
    bodyStart += 1;
  }
  return { yaml, body: normalized.slice(bodyStart) };
}

function parseSkillFrontmatter(source: string): {
  frontmatter: SkillFrontmatter;
  body: string;
} | null {
  const extracted = extractFrontmatterRaw(source);
  if (!extracted) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(extracted.yaml, { schema: "core" });
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return { frontmatter: parsed as SkillFrontmatter, body: extracted.body };
}

// ---------- Body rendering ----------

function renderRequirementsSection(openclaw: SkillMetadataOpenclaw | undefined): string {
  if (!openclaw) {
    return "";
  }
  const lines: string[] = [];
  const bins = openclaw.requires?.bins ?? [];
  const config = openclaw.requires?.config ?? [];
  const osList = openclaw.os ?? [];
  const installs = openclaw.install ?? [];

  if (bins.length === 0 && config.length === 0 && osList.length === 0 && installs.length === 0) {
    return "";
  }

  lines.push("## Requirements");
  lines.push("");

  if (osList.length > 0) {
    lines.push(`- **Supported OS**: ${osList.map((v) => `\`${v}\``).join(", ")}`);
  }
  if (bins.length > 0) {
    lines.push(`- **Required binaries**: ${bins.map((v) => `\`${v}\``).join(", ")}`);
  }
  if (config.length > 0) {
    lines.push(`- **Required config keys**: ${config.map((v) => `\`${v}\``).join(", ")}`);
  }

  if (installs.length > 0) {
    lines.push("");
    lines.push("### Install");
    lines.push("");
    for (const entry of installs) {
      const parts: string[] = [];
      if (entry.label) {
        parts.push(`**${entry.label}**`);
      } else if (entry.kind) {
        parts.push(`**${entry.kind}**`);
      }
      if (entry.formula) {
        parts.push(`formula \`${entry.formula}\``);
      }
      if (entry.package) {
        parts.push(`package \`${entry.package}\``);
      }
      if (parts.length > 0) {
        lines.push(`- ${parts.join(" — ")}`);
      }
    }
  }

  lines.push("");
  return lines.join("\n");
}

function renderHomepageSection(homepage: string | undefined): string {
  if (!homepage) {
    return "";
  }
  return `## Homepage\n\n- ${homepage}\n`;
}

// ---------- Frontmatter output (stable key order) ----------

function serializeSubAgentFrontmatter(params: {
  name: string;
  description: string;
  tools: string[] | undefined;
}): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`name: ${params.name}`);
  // Quote the description to keep colons and special chars safe. Use the `yaml`
  // package's string dump for consistent escaping.
  const desc = YAML.stringify({ description: params.description }, { lineWidth: 0 }).trimEnd();
  lines.push(desc);
  if (params.tools && params.tools.length > 0) {
    const toolsLine = YAML.stringify({ tools: params.tools }, { lineWidth: 0 }).trimEnd();
    lines.push(toolsLine);
  }
  lines.push("---");
  return lines.join("\n");
}

// ---------- Per-skill conversion ----------

function convertSkill(params: { skillDir: string; outputDir: string }): SubAgentWrite | null {
  const skillFile = path.join(params.skillDir, "SKILL.md");
  let source: string;
  try {
    source = fs.readFileSync(skillFile, "utf8");
  } catch {
    return null; // Not a skill directory.
  }
  const parsed = parseSkillFrontmatter(source);
  if (!parsed) {
    return null;
  }

  const fallbackName = path.basename(params.skillDir).trim();
  const name = (parsed.frontmatter.name ?? fallbackName).trim();
  const description = (parsed.frontmatter.description ?? "").trim();
  if (!name || !description) {
    return null;
  }

  const frontmatterText = serializeSubAgentFrontmatter({
    name,
    description,
    tools: parsed.frontmatter["allowed-tools"],
  });

  const requirements = renderRequirementsSection(parsed.frontmatter.metadata?.openclaw);
  const homepage = renderHomepageSection(parsed.frontmatter.homepage);
  // Body is preserved verbatim — ordering matters for determinism and for
  // keeping the skill's original prose intact.
  const bodyNormalized = parsed.body.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const bodyTrimmed = bodyNormalized.replace(/^\n+/, "").replace(/\s+$/, "");

  const chunks: string[] = [frontmatterText, ""];
  if (requirements) {
    chunks.push(requirements);
  }
  if (homepage) {
    chunks.push(homepage);
  }
  if (bodyTrimmed) {
    chunks.push(bodyTrimmed);
  }
  // Ensure the file ends with a single trailing newline.
  const content = chunks.filter((c) => c.length > 0).join("\n") + "\n";

  return {
    outputPath: path.join(params.outputDir, `${name}.md`),
    content,
  };
}

// ---------- Directory enumeration (mirrors listCandidateSkillDirs) ----------

function listCandidateSkillDirs(root: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules",
    )
    .map((entry) => path.join(root, entry.name))
    .toSorted((a, b) => a.localeCompare(b));
}

// ---------- Driver ----------

const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const SKILL_ROOTS = [path.join(REPO_ROOT, "skills"), path.join(REPO_ROOT, ".agents", "skills")];
const OUTPUT_DIR = path.join(REPO_ROOT, ".claude", "agents");

function collectWrites(outputDir: string): { writes: SubAgentWrite[]; skipped: string[] } {
  const writes: SubAgentWrite[] = [];
  const skipped: string[] = [];
  const seenNames = new Map<string, string>();

  for (const root of SKILL_ROOTS) {
    for (const skillDir of listCandidateSkillDirs(root)) {
      const write = convertSkill({ skillDir, outputDir });
      if (!write) {
        skipped.push(skillDir);
        continue;
      }
      const existing = seenNames.get(path.basename(write.outputPath));
      if (existing) {
        // Name collision across skill roots — skip the second to keep output
        // deterministic and flag it.
        skipped.push(`${skillDir} (duplicate of ${existing})`);
        continue;
      }
      seenNames.set(path.basename(write.outputPath), skillDir);
      writes.push(write);
    }
  }

  writes.sort((a, b) => a.outputPath.localeCompare(b.outputPath));
  return { writes, skipped };
}

function writeMode(): number {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const { writes, skipped } = collectWrites(OUTPUT_DIR);

  // Prune any stale .md files that don't correspond to a current skill, so
  // removed/renamed skills don't linger. Only removes files this script would
  // have produced (matching the write set); preserves anything else a user
  // may have added under .claude/agents/.
  const expectedBasenames = new Set(writes.map((w) => path.basename(w.outputPath)));
  try {
    for (const entry of fs.readdirSync(OUTPUT_DIR)) {
      if (!entry.endsWith(".md")) {
        continue;
      }
      if (!expectedBasenames.has(entry)) {
        const fullPath = path.join(OUTPUT_DIR, entry);
        // Only remove files that look like generated sub-agents (start with
        // the "---\nname: " marker). Leave anything else alone.
        try {
          const head = fs.readFileSync(fullPath, "utf8").slice(0, 32);
          if (head.startsWith("---\nname: ")) {
            fs.unlinkSync(fullPath);
          }
        } catch {
          // Ignore — the file may be unreadable or a directory.
        }
      }
    }
  } catch {
    // Directory may not exist yet — that's fine.
  }

  for (const w of writes) {
    fs.writeFileSync(w.outputPath, w.content, "utf8");
  }

  process.stdout.write(`Wrote ${writes.length} sub-agents to ${OUTPUT_DIR}\n`);
  if (skipped.length > 0) {
    process.stdout.write(`Skipped ${skipped.length} skill directories:\n`);
    for (const s of skipped) {
      process.stdout.write(`  - ${s}\n`);
    }
  }
  return 0;
}

function checkMode(): number {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-subagent-check-"));
  try {
    const { writes } = collectWrites(tempRoot);
    // Compare ONLY the files this script produces. writeMode preserves
    // any custom .md files a user manually added under .claude/agents/
    // (they don't match the generated marker), so the drift check has
    // to exclude them too — otherwise a user-added file makes
    // `pnpm skills:subagents:check` red forever with no remediation.
    const drifted: string[] = [];
    for (const w of writes) {
      const expectedBasename = path.basename(w.outputPath);
      const repoPath = path.join(OUTPUT_DIR, expectedBasename);
      if (!fs.existsSync(repoPath)) {
        drifted.push(`missing: ${expectedBasename}`);
        continue;
      }
      const actual = fs.readFileSync(repoPath, "utf8");
      if (actual !== w.content) {
        drifted.push(`changed: ${expectedBasename}`);
      }
    }
    // Also flag files in OUTPUT_DIR that look generated (start with the
    // sub-agent frontmatter marker we always emit) but don't appear in
    // `writes` — that means a generated file lingers from a deleted
    // skill and should be removed by re-running gen.
    try {
      const expectedBasenames = new Set(writes.map((w) => path.basename(w.outputPath)));
      for (const entry of fs.readdirSync(OUTPUT_DIR)) {
        if (!entry.endsWith(".md") || expectedBasenames.has(entry)) {
          continue;
        }
        const fullPath = path.join(OUTPUT_DIR, entry);
        try {
          const head = fs.readFileSync(fullPath, "utf8").slice(0, 32);
          if (head.startsWith("---\nname: ")) {
            drifted.push(`stale generated file: ${entry}`);
          }
        } catch {
          // Ignore unreadable entries — not our problem.
        }
      }
    } catch {
      // OUTPUT_DIR doesn't exist; collectWrites would have flagged
      // everything as "missing" above already.
    }
    if (drifted.length > 0) {
      process.stderr.write(
        ".claude/agents/ is out of date; run `pnpm skills:subagents:gen` and commit the result. Drift:\n",
      );
      for (const d of drifted) {
        process.stderr.write(`  - ${d}\n`);
      }
      return 1;
    }
    process.stdout.write(".claude/agents/ is up to date.\n");
    return 0;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function main(): void {
  const mode = process.argv[2] ?? "--write";
  if (mode === "--write") {
    process.exit(writeMode());
  } else if (mode === "--check") {
    process.exit(checkMode());
  } else {
    process.stderr.write(`Unknown mode: ${mode}\n`);
    process.stderr.write("Usage: migrate-skills-to-subagents.ts [--write|--check]\n");
    process.exit(2);
  }
}

main();
