#!/usr/bin/env -S node --import tsx
/**
 * Migrate MEMORY.md → Progressive Memory Store.
 *
 * Parses MEMORY.md sections into categorized entries and stores them
 * in the progressive SQLite store. MEMORY.md is NEVER modified.
 *
 * Usage:
 *   node --import tsx scripts/migrate-memory-to-progressive.ts [options]
 *
 * Options:
 *   --dry-run       Parse and show what would be stored, but don't write
 *   --verify        After migration, compare recall results
 *   --memory-path   Path to MEMORY.md (default: auto-detect)
 *   --db-path       Path to progressive.db (default: ~/.openclaw/memory/progressive.db)
 *   --verbose       Show detailed output
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  MemoryCategory,
  MemoryPriority,
  MemoryStoreParams,
} from "../src/memory/progressive-types.js";
import { ProgressiveMemoryStore } from "../src/memory/progressive-store.js";

// ─── CLI arg parsing ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const verify = args.includes("--verify");
const verbose = args.includes("--verbose");

function getArgValue(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

const memoryPathArg = getArgValue("--memory-path");
const dbPathArg = getArgValue("--db-path");

// ─── Category mapping ────────────────────────────────────────────────────────

/** Section heading → (category, priority) mapping. */
type SectionMapping = {
  category: MemoryCategory;
  priority: MemoryPriority;
  tags?: string[];
  /** If true, each bullet under this section is a separate entry. */
  splitBullets?: boolean;
};

const SECTION_MAP: Record<string, SectionMapping> = {
  // Top-level sections
  "voice system": { category: "project", priority: "medium", tags: ["voice", "telephony"] },
  "active worktrees": { category: "project", priority: "low", tags: ["worktree", "git"] },
  "experiential continuity project": {
    category: "project",
    priority: "medium",
    tags: ["experiential", "identity"],
  },
  people: { category: "person", priority: "critical", tags: ["people"], splitBullets: false },
  "task activity tracking": {
    category: "instruction",
    priority: "critical",
    tags: ["workflow", "slack", "tracking"],
  },
  "preferences / boundaries": {
    category: "preference",
    priority: "high",
    tags: ["preferences"],
    splitBullets: true,
  },
  "goals / focus (current)": {
    category: "insight",
    priority: "high",
    tags: ["goals", "career"],
  },
  "goals / focus": {
    category: "insight",
    priority: "high",
    tags: ["goals", "career"],
  },
  "strengths / background": {
    category: "fact",
    priority: "medium",
    tags: ["background", "skills"],
  },
  "interests / energy sources": {
    category: "preference",
    priority: "medium",
    tags: ["interests"],
  },
  "time / capacity (current)": {
    category: "fact",
    priority: "medium",
    tags: ["capacity", "time"],
  },
  "time / capacity": {
    category: "fact",
    priority: "medium",
    tags: ["capacity", "time"],
  },
  "default tools (assumed)": {
    category: "preference",
    priority: "medium",
    tags: ["tools"],
  },
  "default tools": {
    category: "preference",
    priority: "medium",
    tags: ["tools"],
  },
  drains: { category: "fact", priority: "low", tags: ["drains", "personal"] },
  challenges: { category: "fact", priority: "medium", tags: ["challenges", "personal"] },
  "projects (active)": {
    category: "project",
    priority: "high",
    tags: ["projects"],
    splitBullets: true,
  },

  // Subsections
  "openclaw (clawdbot) — project deep dive": {
    category: "project",
    priority: "medium",
    tags: ["openclaw", "architecture"],
  },
  openclaw: {
    category: "project",
    priority: "medium",
    tags: ["openclaw", "architecture"],
  },
  "autodev architecture": {
    category: "fact",
    priority: "medium",
    tags: ["autodev", "architecture"],
  },
  "operational learnings": {
    category: "instruction",
    priority: "high",
    tags: ["operational", "learnings"],
    splitBullets: true,
  },
  "technical fixes (clawdbot sdk runner)": {
    category: "decision",
    priority: "medium",
    tags: ["fix", "sdk"],
  },
  "technical fixes": {
    category: "decision",
    priority: "medium",
    tags: ["fix", "technical"],
  },
  "autodev orchestration": {
    category: "instruction",
    priority: "high",
    tags: ["autodev", "orchestration"],
    splitBullets: true,
  },
  "pr merge policy": {
    category: "instruction",
    priority: "critical",
    tags: ["pr", "merge", "policy"],
  },
};

// ─── Parser ──────────────────────────────────────────────────────────────────

type ParsedSection = {
  heading: string;
  level: number;
  content: string;
  mapping: SectionMapping;
};

function parseMemoryMd(content: string): ParsedSection[] {
  const lines = content.split("\n");
  const sections: ParsedSection[] = [];
  let currentHeading = "";
  let currentLevel = 0;
  let currentContent: string[] = [];
  let currentMapping: SectionMapping | null = null;

  const flush = () => {
    if (currentHeading && currentMapping && currentContent.length > 0) {
      const text = currentContent.join("\n").trim();
      if (text.length > 0) {
        sections.push({
          heading: currentHeading,
          level: currentLevel,
          content: text,
          mapping: currentMapping,
        });
      }
    }
  };

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      flush();
      const level = headingMatch[1]!.length;
      const heading = headingMatch[2]!.trim();
      const normalizedHeading = heading.toLowerCase().replace(/\*\*/g, "");

      // Try exact match first, then partial match
      let mapping = SECTION_MAP[normalizedHeading] ?? null;
      if (!mapping) {
        // Try partial match
        for (const [key, value] of Object.entries(SECTION_MAP)) {
          if (normalizedHeading.includes(key) || key.includes(normalizedHeading)) {
            mapping = value;
            break;
          }
        }
      }

      // Default mapping for unmapped sections
      if (!mapping) {
        mapping = { category: "fact", priority: "medium", tags: ["uncategorized"] };
      }

      currentHeading = heading;
      currentLevel = level;
      currentContent = [];
      currentMapping = mapping;
      continue;
    }

    // Skip horizontal rules
    if (line.match(/^---+$/)) continue;

    currentContent.push(line);
  }

  flush();
  return sections;
}

function sectionToEntries(section: ParsedSection): MemoryStoreParams[] {
  const mapping = section.mapping;

  // For splitBullets sections, each top-level bullet becomes a separate entry
  if (mapping.splitBullets) {
    const bullets = splitIntoBullets(section.content);
    if (bullets.length > 0) {
      return bullets.map((bullet) => ({
        category: mapping.category,
        content: bullet.trim(),
        context: `Migrated from MEMORY.md section: ${section.heading}`,
        priority: mapping.priority,
        tags: [...(mapping.tags ?? []), "migrated"],
        source: "migration" as const,
      }));
    }
  }

  // Single entry for the whole section
  return [
    {
      category: mapping.category,
      content: section.content,
      context: `Migrated from MEMORY.md section: ${section.heading}`,
      priority: mapping.priority,
      tags: [...(mapping.tags ?? []), "migrated"],
      source: "migration" as const,
    },
  ];
}

/**
 * Split content into top-level bullets. Preserves sub-bullets under their parent.
 */
function splitIntoBullets(content: string): string[] {
  const lines = content.split("\n");
  const bullets: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    // Top-level bullet (starts with - or * at column 0)
    if (/^[-*]\s/.test(line)) {
      if (current.length > 0) {
        bullets.push(current.join("\n"));
      }
      current = [line];
    } else if (line.trim() === "") {
      // Empty line — flush if we have content
      if (current.length > 0) {
        bullets.push(current.join("\n"));
        current = [];
      }
    } else {
      // Continuation or sub-bullet
      current.push(line);
    }
  }

  if (current.length > 0) {
    bullets.push(current.join("\n"));
  }

  return bullets.filter((b) => b.trim().length > 0);
}

// ─── Priority overrides for critical content ─────────────────────────────────

function assignPriority(content: string, defaultPriority: MemoryPriority): MemoryPriority {
  const lower = content.toLowerCase();

  // Channel IDs are critical
  if (/c0[a-z0-9]{8,}/i.test(content)) return "critical";

  // Slack IDs are critical
  if (/u0[a-z0-9]{8,}/i.test(content)) return "critical";

  // "Never" / "Always" / "REQUIRED" instructions are critical
  if (/\b(never|always|required|mandatory|important)\b/i.test(lower)) {
    return defaultPriority === "critical" ? "critical" : "high";
  }

  return defaultPriority;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // Find MEMORY.md
  const memoryPath =
    memoryPathArg ??
    findMemoryMd([
      path.join(process.cwd(), "MEMORY.md"),
      path.join(os.homedir(), "clawd", "MEMORY.md"),
    ]);

  if (!memoryPath) {
    console.error("❌ Could not find MEMORY.md. Use --memory-path to specify.");
    process.exit(1);
  }

  console.log(`📄 Reading: ${memoryPath}`);
  const content = fs.readFileSync(memoryPath, "utf-8");
  console.log(`   ${content.length} chars, ~${Math.ceil(content.length / 4)} tokens`);

  // Parse sections
  const sections = parseMemoryMd(content);
  console.log(`📋 Parsed ${sections.length} sections`);

  // Generate entries
  const allEntries: MemoryStoreParams[] = [];
  for (const section of sections) {
    const entries = sectionToEntries(section);
    for (const entry of entries) {
      // Override priority based on content analysis
      entry.priority = assignPriority(entry.content, entry.priority ?? "medium");
      allEntries.push(entry);
    }
  }

  console.log(`📦 Generated ${allEntries.length} memory entries`);

  // Summary by category
  const byCat: Record<string, number> = {};
  const byPri: Record<string, number> = {};
  let totalTokens = 0;
  for (const entry of allEntries) {
    byCat[entry.category] = (byCat[entry.category] ?? 0) + 1;
    const pri = entry.priority ?? "medium";
    byPri[pri] = (byPri[pri] ?? 0) + 1;
    totalTokens += Math.ceil(entry.content.length / 4);
  }

  console.log("\n📊 Distribution:");
  console.log("   By category:", byCat);
  console.log("   By priority:", byPri);
  console.log(`   Total tokens: ~${totalTokens}`);

  if (verbose) {
    console.log("\n📝 Entries:");
    for (const entry of allEntries) {
      const preview = entry.content.slice(0, 80).replace(/\n/g, " ");
      console.log(`   [${entry.category}/${entry.priority}] ${preview}...`);
    }
  }

  if (dryRun) {
    console.log("\n🏁 Dry run complete — no data was written.");
    return;
  }

  // Open or create the progressive store
  const dbPath = dbPathArg ?? path.join(os.homedir(), ".openclaw", "memory", "progressive.db");
  console.log(`\n💾 Writing to: ${dbPath}`);

  const store = new ProgressiveMemoryStore({ dbPath });

  try {
    let stored = 0;
    let deduplicated = 0;
    let errors = 0;

    for (const entry of allEntries) {
      try {
        const result = await store.store(entry);
        if (result.deduplicated) {
          deduplicated++;
        } else {
          stored++;
        }
      } catch (err) {
        errors++;
        if (verbose) {
          const preview = entry.content.slice(0, 60).replace(/\n/g, " ");
          console.error(`   ❌ Failed: ${preview}... — ${err}`);
        }
      }
    }

    console.log(`\n✅ Migration complete:`);
    console.log(`   Stored: ${stored}`);
    console.log(`   Deduplicated: ${deduplicated}`);
    if (errors > 0) console.log(`   Errors: ${errors}`);

    // Show store stats
    const stats = store.status();
    console.log(`\n📊 Store stats after migration:`);
    console.log(`   Total entries: ${stats.totalEntries}`);
    console.log(`   By category:`, stats.byCategory);
    console.log(`   Total tokens: ~${stats.totalTokensEstimated}`);

    if (verify) {
      console.log("\n🔍 Verification — testing recall...");
      // Test a few basic queries
      const queries = ["David", "OpenClaw", "preferences", "channel IDs", "wedding"];
      for (const q of queries) {
        const results = store.searchFts(q, { limit: 3 });
        console.log(
          `   "${q}" → ${results.length} results${results.length > 0 ? ` (top: ${results[0]!.content.slice(0, 50).replace(/\n/g, " ")}...)` : ""}`,
        );
      }
    }
  } finally {
    store.close();
  }
}

function findMemoryMd(candidates: string[]): string | undefined {
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

main().catch((err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});
