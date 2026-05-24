/**
 * Generate skills/manifest.json from skills/*\/SKILL.md frontmatter.
 *
 * Usage:
 *   pnpm skills:manifest           — generate and write manifest.json (also normalizes SKILL.md files)
 *   pnpm skills:manifest --check   — fail if the committed manifest is out of sync
 *
 * Normalization (applied both when generating and for contentHash):
 *   - LF line endings
 *   - trailing whitespace stripped per line
 *   - single trailing newline
 *
 * contentHash = sha256 of the full normalized SKILL.md (including frontmatter).
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SKILLS_DIR = path.join(REPO_ROOT, "skills");
const MANIFEST_PATH = path.join(SKILLS_DIR, "manifest.json");

const CHECK_MODE = process.argv.includes("--check");

/**
 * Skill directories that intentionally do NOT participate in the canonical
 * registry. They may exist as documentation-only skills (no frontmatter at
 * all) or carry frontmatter without the `metadata.openclaw` block. They are
 * skipped silently.
 *
 * Any OTHER directory that fails to parse cleanly is treated as a hard error
 * in generate / check modes, so frontmatter regressions surface in CI rather
 * than silently dropping a skill from the manifest.
 */
const NON_CANONICAL_ALLOWLIST = new Set<string>(["canvas", "healthcheck", "skill-creator"]);

// ── types ─────────────────────────────────────────────────────────────────────

type SkillRequires = {
  env?: string[];
  bins?: string[];
};

type ManifestEntry = {
  contentHash: string;
  description: string;
  emoji: string;
  name: string;
  path: string;
  requires: SkillRequires;
};

// ── helpers ───────────────────────────────────────────────────────────────────

function normalizeContent(raw: string): string {
  const lines = raw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd());
  // Remove any trailing blank lines then add exactly one trailing newline.
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.join("\n") + "\n";
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

type FrontmatterResult =
  | {
      ok: true;
      name: string;
      description: string;
      emoji: string;
      requires: SkillRequires;
    }
  | { ok: false; reason: string };

function parseFrontmatter(normalized: string, skillDir: string): FrontmatterResult {
  if (!normalized.startsWith("---\n")) {
    return { ok: false, reason: "no frontmatter block" };
  }
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1) {
    return { ok: false, reason: "unterminated frontmatter block" };
  }
  const yamlStr = normalized.slice(4, end);

  let parsed: unknown;
  try {
    parsed = parseYaml(yamlStr);
  } catch (err) {
    return { ok: false, reason: `YAML parse error: ${String(err)}` };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "frontmatter is not a YAML object" };
  }

  const fm = parsed as Record<string, unknown>;

  const name = typeof fm["name"] === "string" ? fm["name"].trim() : "";
  if (!name) {
    return { ok: false, reason: "missing or empty `name` field" };
  }

  const description = typeof fm["description"] === "string" ? fm["description"].trim() : "";
  if (!description) {
    return { ok: false, reason: "missing or empty `description` field" };
  }

  // metadata is a JSON-in-YAML block: { openclaw: { emoji, requires } }
  const meta = fm["metadata"];
  const openclaw =
    meta && typeof meta === "object" && !Array.isArray(meta) && "openclaw" in meta
      ? (meta as Record<string, unknown>)["openclaw"]
      : null;

  if (!openclaw || typeof openclaw !== "object" || Array.isArray(openclaw)) {
    return { ok: false, reason: "missing metadata.openclaw block" };
  }

  const oc = openclaw as Record<string, unknown>;
  const emoji = typeof oc["emoji"] === "string" ? oc["emoji"] : "";
  const requiresRaw = oc["requires"];

  const requires: SkillRequires = {};
  if (requiresRaw && typeof requiresRaw === "object" && !Array.isArray(requiresRaw)) {
    const r = requiresRaw as Record<string, unknown>;
    if (Array.isArray(r["env"]) && r["env"].every((x) => typeof x === "string")) {
      requires.env = r["env"];
    }
    if (Array.isArray(r["bins"]) && r["bins"].every((x) => typeof x === "string")) {
      requires.bins = r["bins"];
    }
  }

  void skillDir; // used only for error messages above
  return { ok: true, name, description, emoji, requires };
}

function buildEntry(
  name: string,
  normalized: string,
  skillPath: string,
  fm: { description: string; emoji: string; requires: SkillRequires },
): ManifestEntry {
  const hash = sha256Hex(normalized);
  return {
    contentHash: `sha256:${hash}`,
    description: fm.description,
    emoji: fm.emoji,
    name,
    path: skillPath,
    requires: fm.requires,
  };
}

function stableJson(entries: ManifestEntry[]): string {
  // Sort entries by name; sort keys within each object alphabetically.
  const sorted = [...entries].toSorted((a, b) => a.name.localeCompare(b.name));
  const stable = sorted.map((entry) => {
    const keys = Object.keys(entry).toSorted() as (keyof ManifestEntry)[];
    const obj: Record<string, unknown> = {};
    for (const k of keys) {
      const v = entry[k];
      if (k === "requires" && typeof v === "object" && v !== null) {
        // Sort requires sub-keys too.
        const rkeys = Object.keys(v as object).toSorted();
        const r: Record<string, unknown> = {};
        for (const rk of rkeys) {
          r[rk] = (v as Record<string, unknown>)[rk];
        }
        obj[k] = r;
      } else {
        obj[k] = v;
      }
    }
    return obj;
  });
  return JSON.stringify(stable, null, 2) + "\n";
}

/**
 * Run `oxfmt` on a file in-place. Returns true on success, false otherwise.
 * Used after writing manifest.json (and after writing a temp file in --check)
 * so the committed manifest matches what `pnpm format:check` expects.
 */
function oxfmtInPlace(filePath: string): { ok: boolean; stderr?: string } {
  const result = spawnSync("pnpm", ["exec", "oxfmt", filePath], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return { ok: false, stderr: result.stderr || result.stdout || "(no output)" };
  }
  return { ok: true };
}

// ── main ──────────────────────────────────────────────────────────────────────

function main() {
  if (!existsSync(SKILLS_DIR)) {
    console.error(`skills/ directory not found at ${SKILLS_DIR}`);
    process.exit(1);
  }

  const entries: ManifestEntry[] = [];
  const skippedAllowlisted: string[] = [];
  const errors: string[] = [];

  const skillDirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .toSorted();

  for (const dir of skillDirs) {
    const skillFile = path.join(SKILLS_DIR, dir, "SKILL.md");
    if (!existsSync(skillFile)) {
      // No SKILL.md at all is always allowed — could be an asset-only directory.
      continue;
    }

    const raw = readFileSync(skillFile, "utf8");
    const normalized = normalizeContent(raw);
    const fm = parseFrontmatter(normalized, dir);

    if (!fm.ok) {
      if (NON_CANONICAL_ALLOWLIST.has(dir)) {
        skippedAllowlisted.push(`${dir}: ${fm.reason}`);
        continue;
      }
      errors.push(`${dir}: ${fm.reason}`);
      continue;
    }

    // Enforce frontmatter.name === directory name. The generator and the
    // dashboard both key off the directory name; a mismatch would mask a
    // rename / typo and silently drift identity vs. provenance.
    if (fm.name !== dir) {
      if (NON_CANONICAL_ALLOWLIST.has(dir)) {
        skippedAllowlisted.push(`${dir}: frontmatter.name='${fm.name}' (allowlisted)`);
        continue;
      }
      errors.push(`${dir}: frontmatter.name='${fm.name}' does not match directory name`);
      continue;
    }

    if (!CHECK_MODE) {
      // Write normalized file back so the committed hash matches the image.
      if (normalized !== raw) {
        writeFileSync(skillFile, normalized, "utf8");
      }
    }

    const relPath = `skills/${dir}/SKILL.md`;
    const entry = buildEntry(dir, normalized, relPath, fm);
    entries.push(entry);
  }

  if (errors.length > 0) {
    console.error("ERROR: canonical-skill frontmatter problems:");
    for (const e of errors) {
      console.error(`  - ${e}`);
    }
    console.error(
      "\nFix the SKILL.md files above, or add the directory to NON_CANONICAL_ALLOWLIST in this script if it should not be canonical.",
    );
    process.exit(1);
  }

  if (skippedAllowlisted.length > 0) {
    console.log("Skipped (non-canonical allowlist):");
    for (const s of skippedAllowlisted) {
      console.log(`  - ${s}`);
    }
  }

  const generated = stableJson(entries);

  if (CHECK_MODE) {
    if (!existsSync(MANIFEST_PATH)) {
      console.error("skills/manifest.json does not exist. Run `pnpm skills:manifest` to generate.");
      process.exit(1);
    }
    // Write the generator's raw output to a tempfile, oxfmt it, then compare
    // against the committed manifest. This catches both content drift and
    // formatter drift in one shot — the committed manifest must be exactly
    // what `pnpm skills:manifest` (which includes the oxfmt post-step) would
    // produce.
    const tmpDir = mkdtempSync(path.join(tmpdir(), "skills-manifest-check-"));
    const tmpPath = path.join(tmpDir, "manifest.json");
    try {
      writeFileSync(tmpPath, generated, "utf8");
      const fmt = oxfmtInPlace(tmpPath);
      if (!fmt.ok) {
        console.error(`oxfmt failed on temp manifest: ${fmt.stderr ?? ""}`);
        process.exit(1);
      }
      const formatted = readFileSync(tmpPath, "utf8");
      const committed = readFileSync(MANIFEST_PATH, "utf8");
      if (committed !== formatted) {
        console.error(
          "skills/manifest.json is out of sync with the SKILL.md files.\n" +
            "Run `pnpm skills:manifest` to regenerate, then commit the result.",
        );
        process.exit(1);
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
    console.log(`skills/manifest.json is up to date (${entries.length} skills).`);
    return;
  }

  writeFileSync(MANIFEST_PATH, generated, "utf8");
  const fmt = oxfmtInPlace(MANIFEST_PATH);
  if (!fmt.ok) {
    console.error(`oxfmt failed on skills/manifest.json: ${fmt.stderr ?? ""}`);
    process.exit(1);
  }
  console.log(`Wrote skills/manifest.json with ${entries.length} skills.`);
}

main();
