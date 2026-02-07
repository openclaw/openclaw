import { readFile, writeFile, access } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface DashboardMapping {
  memoryFile: string;
  dashboardPath: string;
  sections: string[];
}

const PROJECT_MAP: DashboardMapping[] = [
  {
    memoryFile: "MEMORY.md",
    dashboardPath: "_MASTER_DASHBOARD.md",
    sections: ["active-projects"],
  },
  {
    memoryFile: "memory/maioss.md",
    dashboardPath: "04.MAIOSS/_DASHBOARD.md",
    sections: ["milestones", "open-tasks", "decisions", "test-health"],
  },
  {
    memoryFile: "memory/vietnam-beauty.md",
    dashboardPath: "07.MAIBEAUTY/_DASHBOARD.md",
    sections: ["ai-models", "admin-phases", "open-tasks", "decisions"],
  },
];

const MAIBOT_DASHBOARD = "00.MAIBOT/_DASHBOARD.md";

// ---------------------------------------------------------------------------
// Vault path resolution
// ---------------------------------------------------------------------------

function resolveVaultPath(): string {
  if (process.env.MAIBOT_OBSIDIAN_VAULT) {
    return process.env.MAIBOT_OBSIDIAN_VAULT;
  }
  const home = os.homedir();
  return path.join(home, "OneDrive", "Documents", "JINI_SYNC", "01.PROJECT");
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// replaceAutoSection — reuse pattern from sync-moonshot-docs.ts
// ---------------------------------------------------------------------------

function replaceAutoSection(
  text: string,
  sectionName: string,
  lines: string[],
): string {
  const startMarker = `<!-- AUTO:${sectionName}:START -->`;
  const endMarker = `<!-- AUTO:${sectionName}:END -->`;

  const startIndex = text.indexOf(startMarker);
  if (startIndex === -1) {
    console.warn(`  [skip] marker not found: ${startMarker}`);
    return text;
  }
  const endIndex = text.indexOf(endMarker, startIndex);
  if (endIndex === -1) {
    console.warn(`  [skip] end marker not found: ${endMarker}`);
    return text;
  }

  const endLineEnd = text.indexOf("\n", endIndex);
  const endLineEndIndex = endLineEnd === -1 ? text.length : endLineEnd + 1;

  const before = text.slice(0, startIndex);
  const after = text.slice(endLineEndIndex);

  const replacement = [startMarker, ...lines, endMarker].join("\n");

  if (!after) return `${before}${replacement}`;
  return `${before}${replacement}\n${after}`;
}

// ---------------------------------------------------------------------------
// Memory file parsing helpers
// ---------------------------------------------------------------------------

function extractSectionContent(
  text: string,
  heading: string,
  headingLevel = 2,
): string | null {
  const prefix = "#".repeat(headingLevel);
  const regex = new RegExp(
    `^${prefix}\\s+${escapeRegex(heading)}\\s*$`,
    "m",
  );
  const match = regex.exec(text);
  if (!match) return null;

  const start = match.index + match[0].length;
  const nextHeadingRegex = new RegExp(`^#{1,${headingLevel}}\\s`, "m");
  const rest = text.slice(start);
  const nextMatch = nextHeadingRegex.exec(rest);
  const end = nextMatch ? start + nextMatch.index : text.length;

  return text.slice(start, end).trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractCheckboxItems(
  section: string,
  uncheckedOnly: boolean,
): string[] {
  if (uncheckedOnly) {
    return section.split("\n").filter((line) => /^\s*-\s*\[\s\]/.test(line));
  }
  return section.split("\n").filter((line) => /^\s*-\s*\[[ x]\]/.test(line));
}

// ---------------------------------------------------------------------------
// Project-specific extractors
// ---------------------------------------------------------------------------

function extractMasterActiveProjects(memoryText: string): string[] {
  const section = extractSectionContent(memoryText, "활성 프로젝트");
  if (!section) return [];

  const header =
    "| # | Project | Status | Local Path | GitHub | Last Activity |";
  const separator =
    "|---|---------|--------|------------|--------|---------------|";

  const dataRows: string[] = [];

  // Only parse lines before the first ### subsection to avoid "개발 환경 요약" table
  const sectionBeforeSub = section.split(/^###\s/m)[0];
  const tableRows = sectionBeforeSub.split("\n").filter((l) => l.startsWith("|"));

  for (const row of tableRows) {
    if (row.match(/^\|\s*[-:]+/)) continue; // separator
    if (row.includes("프로젝트") && row.includes("상태")) continue; // header

    const cells = row
      .split("|")
      .map((c) => c.trim())
      .filter(Boolean);
    if (cells.length < 4) continue;

    const projectName = cells[1];
    const status = cells[3];

    const statusEmoji =
      status === "🟢 진행중" ? ":green_circle: Active" : status;

    let obsidianNum: string;
    let link: string;
    let github: string;
    let localPath: string;

    if (projectName.includes("MAIOSS")) {
      obsidianNum = "04";
      link = "[[04.MAIOSS/_DASHBOARD|MAIOSS]]";
      github =
        "[jini92/MAIOSS](https://github.com/jini92/MAIOSS)";
      localPath = "`C:\\TEST\\MAIOSS`";
    } else {
      obsidianNum = "07";
      link = "[[07.MAIBEAUTY/_DASHBOARD|MAIBEAUTY]]";
      github =
        "[jini92/MAIBEAUTY](https://github.com/jini92/MAIBEAUTY)";
      localPath = "`C:\\TEST\\MAIBEAUTY`";
    }

    const today = new Date().toISOString().slice(0, 10);
    dataRows.push(
      `| ${obsidianNum} | ${link} | ${statusEmoji} | ${localPath} | ${github} | ${today} |`,
    );
  }

  // Always include MAIBOT at position 00
  const today = new Date().toISOString().slice(0, 10);
  const maibotRow = `| 00 | [[00.MAIBOT/_DASHBOARD|MAIBOT]] | :green_circle: Active | \`C:\\MAIBOT\` | [jini92/MAIBOT](https://github.com/jini92/MAIBOT) | ${today} |`;

  return [header, separator, maibotRow, ...dataRows];
}

function extractMaiossMilestones(memoryText: string): string[] {
  const header = "| Milestone | Status | Date |";
  const separator = "|-----------|--------|------|";
  const milestones: string[] = [header, separator];

  const section = extractSectionContent(memoryText, "다음 단계");
  if (!section) return milestones;

  // Match completed milestone headings: ### ✅ Name (date)
  const completedHeadings = [
    ...section.matchAll(/^###\s+✅\s+(.+?)(?:\s*\(([^)]+)\))?\s*$/gm),
  ];
  for (const m of completedHeadings) {
    const name = m[1].trim();
    const date = m[2]?.trim() ?? "";
    milestones.push(
      `| ${name} | :white_check_mark: Complete | ${date} |`,
    );
  }

  return milestones;
}

function extractMaiossOpenTasks(memoryText: string): string[] {
  const section = extractSectionContent(memoryText, "기존 과제", 3);
  if (!section) {
    const altSection = extractSectionContent(memoryText, "다음 단계");
    if (!altSection) return [];
    return extractCheckboxItems(altSection, true);
  }
  return extractCheckboxItems(section, true);
}

function extractMaiossDecisions(memoryText: string): string[] {
  const section = extractSectionContent(memoryText, "결정 사항");
  if (!section) return [];

  const rows = section.split("\n").filter((l) => l.startsWith("|"));
  const header = "| Date | Decision | Reason |";
  const separator = "|------|----------|--------|";

  const dataRows = rows.filter(
    (r) => !r.match(/^\|\s*[-:]+/) && !(r.includes("날짜") && r.includes("결정")),
  );

  // Take last 5
  const recent = dataRows.slice(-5);
  return [header, separator, ...recent];
}

function extractMaiossTestHealth(memoryText: string): string[] {
  const header = "| Category | Count | Status |";
  const separator = "|----------|-------|--------|";
  const rows: string[] = [header, separator];

  // Core test results from "최종 테스트 결과"
  const testMatch = memoryText.match(
    /\*\*(\d+ passed, \d+ skipped, \d+ failed)\*\*/,
  );
  if (testMatch) {
    rows.push(`| 핵심 테스트 | ${testMatch[1]} | :green_circle: |`);
  }

  // Rev.5 test results
  const totalMatch = memoryText.match(
    /총 테스트:\s*(\d+)\s*passed,\s*(\d+)\s*failed/,
  );
  if (totalMatch) {
    rows.push(
      `| Rev.5 테스트 | ${totalMatch[1]} passed, ${totalMatch[2]} failed | :green_circle: |`,
    );
  }

  // ES10500 compliance
  const pctMatch = memoryText.match(/충족률.*?~?([\d.]+)%/);
  if (pctMatch) {
    rows.push(
      `| ES10500 규정 준수 | ${pctMatch[1]}% | :green_circle: |`,
    );
  }

  // Project health
  const healthMatch = memoryText.match(
    /프로젝트 건강도:\s*(⭐+)\s*\/\s*(\d+)/,
  );
  if (healthMatch) {
    const stars = (healthMatch[1].match(/⭐/g) || []).length;
    rows.push(
      `| 프로젝트 건강도 | ${stars}/${healthMatch[2]} stars | :green_circle: |`,
    );
  }

  return rows;
}

function extractBeautyAiModels(memoryText: string): string[] {
  const header = "| Phase | Model | Description | Status |";
  const separator = "|-------|-------|-------------|--------|";
  const rows: string[] = [header, separator];

  const phaseMap: [string, string][] = [
    ["Phase 1. Discovery (발견)", "Discovery"],
    ["Phase 2. Search (검색/비교)", "Search"],
    ["Phase 3. Loyalty (관계/재구매)", "Loyalty"],
  ];

  for (const [phaseHeading, phaseName] of phaseMap) {
    const section = extractSectionContent(memoryText, phaseHeading, 3);
    if (!section) continue;

    const tableRows = section
      .split("\n")
      .filter(
        (l) =>
          l.startsWith("|") &&
          !l.match(/^\|\s*[-:]+/) &&
          !(l.includes("모델") && l.includes("설명")),
      );

    for (const row of tableRows) {
      const cells = row
        .split("|")
        .map((c) => c.trim())
        .filter(Boolean);
      if (cells.length < 3) continue;

      const model = cells[0];
      const desc = cells[1];
      const rawStatus = cells[2];

      let status = rawStatus;
      if (rawStatus.includes("🟢")) {
        status = `:green_circle: ${rawStatus.replace("🟢", "").trim()}`;
      } else if (rawStatus.includes("🟡")) {
        status = `:yellow_circle: ${rawStatus.replace("🟡", "").trim()}`;
      }

      rows.push(`| ${phaseName} | ${model} | ${desc} | ${status} |`);
    }
  }

  return rows;
}

function extractBeautyAdminPhases(memoryText: string): string[] {
  const header = "| Phase | Module | Hours | Status |";
  const separator = "|-------|--------|-------|--------|";
  const rows: string[] = [header, separator];

  const section = extractSectionContent(memoryText, "개발 일정 (5주)", 3);
  if (!section) return rows;

  const tableRows = section
    .split("\n")
    .filter(
      (l) =>
        l.startsWith("|") &&
        !l.match(/^\|\s*[-:]+/) &&
        !(l.includes("기간") && l.includes("내용") && l.includes("상태")),
    );

  for (const row of tableRows) {
    const cells = row
      .split("|")
      .map((c) => c.trim())
      .filter(Boolean);
    if (cells.length < 5) continue;

    const phase = cells[0];
    const module = cells[2];
    const hours = cells[3];
    const rawStatus = cells[4];

    let status = rawStatus;
    if (rawStatus.includes("✅")) {
      status = ":white_check_mark: Complete";
    }

    if (phase.includes("Total")) {
      const cleanHours = hours.replace(/\*\*/g, "");
      rows.push(`| **Total** | **${cleanHours}** | | **v1.0.0 Released** |`);
    } else {
      rows.push(`| ${phase} | ${module} | ${hours} | ${status} |`);
    }
  }

  return rows;
}

function extractBeautyOpenTasks(memoryText: string): string[] {
  const lines: string[] = [];

  const section = extractSectionContent(memoryText, "다음 액션");
  if (!section) return lines;

  // "🟡 지니 액션 필요" unchecked items
  const jiniSection = extractSectionContent(
    `## dummy\n${section}`,
    "🟡 지니 액션 필요",
    3,
  );
  if (jiniSection) {
    const pending = extractCheckboxItems(jiniSection, true);
    if (pending.length > 0) {
      lines.push("### Pending (Requires Action)");
      lines.push(...pending);
    }
  }

  // "🟢 다음 단계" unchecked items
  const nextSection = extractSectionContent(
    `## dummy\n${section}`,
    "🟢 다음 단계",
    3,
  );
  if (nextSection) {
    const next = extractCheckboxItems(nextSection, true);
    if (next.length > 0) {
      lines.push("");
      lines.push("### Next Development");
      lines.push(...next);
    }
  }

  return lines;
}

function extractBeautyDecisions(memoryText: string): string[] {
  let section = extractSectionContent(memoryText, "결정 사항");
  if (!section) {
    section = extractSectionContent(memoryText, "주요 결정사항");
  }
  if (!section) return [];

  const rows = section.split("\n").filter((l) => l.startsWith("|"));
  const header = "| Date | Decision | Reason |";
  const separator = "|------|----------|--------|";

  const dataRows = rows.filter(
    (r) =>
      !r.match(/^\|\s*[-:]+/) &&
      !(r.includes("날짜") && r.includes("결정")),
  );

  const recent = dataRows.slice(-5);
  return [header, separator, ...recent];
}

function extractRecentCommits(): string[] {
  try {
    const log = execFileSync(
      "git",
      ["log", "--oneline", "-5", "--format=%h %s"],
      { cwd: repoRoot, encoding: "utf-8" },
    ).trim();

    return ["```", ...log.split("\n"), "```"];
  } catch {
    return ["```", "(no commits available)", "```"];
  }
}

// ---------------------------------------------------------------------------
// Dashboard update
// ---------------------------------------------------------------------------

async function updateDashboardFile(
  vaultPath: string,
  dashboardRelPath: string,
  sections: Record<string, string[]>,
): Promise<boolean> {
  const filePath = path.join(vaultPath, dashboardRelPath);

  if (!(await pathExists(filePath))) {
    console.warn(`  [skip] dashboard not found: ${filePath}`);
    return false;
  }

  let text = await readFile(filePath, "utf-8");
  let changed = false;

  for (const [sectionName, lines] of Object.entries(sections)) {
    const before = text;
    text = replaceAutoSection(text, sectionName, lines);
    if (text !== before) changed = true;
  }

  if (changed) {
    const today = new Date().toISOString().slice(0, 10);
    text = text.replace(/^(updated:\s*).+$/m, `$1${today}`);
    text = text.replace(
      /\*Updated by MAIBOT session on .+\*/,
      `*Updated by MAIBOT session on ${today}*`,
    );

    await writeFile(filePath, text);
    console.log(`  [updated] ${dashboardRelPath}`);
  } else {
    console.log(`  [no change] ${dashboardRelPath}`);
  }

  return changed;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const vaultPath = resolveVaultPath();

  if (!(await pathExists(vaultPath))) {
    console.warn(
      `[sync-obsidian] vault not found: ${vaultPath} — skipping`,
    );
    process.exit(0);
  }

  console.log(`[sync-obsidian] vault: ${vaultPath}`);

  // Determine which memory files changed (from CLI args or all)
  const changedFiles =
    process.argv.length > 2
      ? process.argv.slice(2)
      : PROJECT_MAP.map((m) => m.memoryFile);

  const changedSet = new Set(
    changedFiles.map((f) => f.replace(/\\/g, "/")),
  );

  let anyUpdated = false;

  for (const mapping of PROJECT_MAP) {
    const normalizedMemory = mapping.memoryFile.replace(/\\/g, "/");
    if (!changedSet.has(normalizedMemory)) continue;

    const memoryPath = path.join(repoRoot, mapping.memoryFile);
    if (!(await pathExists(memoryPath))) {
      console.warn(`  [skip] memory file not found: ${memoryPath}`);
      continue;
    }

    let memoryText: string;
    try {
      memoryText = await readFile(memoryPath, "utf-8");
    } catch (err) {
      console.warn(`  [skip] failed to read: ${memoryPath} — ${err}`);
      continue;
    }

    console.log(`\n[processing] ${mapping.memoryFile}`);

    const sections: Record<string, string[]> = {};

    for (const sectionName of mapping.sections) {
      try {
        sections[sectionName] = buildSection(
          mapping.memoryFile,
          sectionName,
          memoryText,
        );
      } catch (err) {
        console.warn(`  [skip] section ${sectionName}: ${err}`);
        sections[sectionName] = [];
      }
    }

    const updated = await updateDashboardFile(
      vaultPath,
      mapping.dashboardPath,
      sections,
    );
    if (updated) anyUpdated = true;
  }

  // Always update MAIBOT recent commits
  console.log(`\n[processing] MAIBOT recent commits`);
  const commits = extractRecentCommits();
  const updated = await updateDashboardFile(vaultPath, MAIBOT_DASHBOARD, {
    "recent-commits": commits,
  });
  if (updated) anyUpdated = true;

  // Generate Kanban boards
  for (const kanban of KANBAN_MAP) {
    const normalizedMemory = kanban.memoryFile.replace(/\\/g, "/");
    if (!changedSet.has(normalizedMemory)) continue;

    const memoryPath = path.join(repoRoot, kanban.memoryFile);
    if (!(await pathExists(memoryPath))) {
      console.warn(`  [skip] memory file not found: ${memoryPath}`);
      continue;
    }

    let memoryText: string;
    try {
      memoryText = await readFile(memoryPath, "utf-8");
    } catch (err) {
      console.warn(`  [skip] failed to read: ${memoryPath} — ${err}`);
      continue;
    }

    console.log(`\n[kanban] ${kanban.memoryFile} → ${kanban.kanbanPath}`);

    try {
      const columns = kanban.extractor(memoryText);
      const content = buildKanbanContent(columns);
      const kanbanUpdated = await writeKanbanFile(
        vaultPath,
        kanban.kanbanPath,
        content,
      );
      if (kanbanUpdated) anyUpdated = true;
    } catch (err) {
      console.warn(`  [skip] kanban generation failed: ${err}`);
    }
  }

  if (anyUpdated) {
    console.log("\n[sync-obsidian] dashboards updated successfully");
  } else {
    console.log("\n[sync-obsidian] no dashboards needed updating");
  }
}

// ---------------------------------------------------------------------------
// Kanban board generation
// ---------------------------------------------------------------------------

interface KanbanMapping {
  memoryFile: string;
  kanbanPath: string;
  extractor: (text: string) => KanbanColumns;
}

interface KanbanColumns {
  [columnName: string]: string[];
}

const KANBAN_MAP: KanbanMapping[] = [
  {
    memoryFile: "memory/maioss.md",
    kanbanPath: "04.MAIOSS/_KANBAN.md",
    extractor: extractMaiossKanbanColumns,
  },
  {
    memoryFile: "memory/vietnam-beauty.md",
    kanbanPath: "07.MAIBEAUTY/_KANBAN.md",
    extractor: extractBeautyKanbanColumns,
  },
];

function extractMaiossKanbanColumns(memoryText: string): KanbanColumns {
  const columns: KanbanColumns = {};

  // Done: completed milestone headings (### ✅ ...), most recent 5
  const doneItems: string[] = [];
  const milestoneMatches = [
    ...memoryText.matchAll(/^###\s+✅\s+(.+?)(?:\s*\(([^)]+)\))?\s*$/gm),
  ];
  const recentMilestones = milestoneMatches.slice(-5);
  for (const m of recentMilestones) {
    const name = m[1].trim();
    const date = m[2]?.trim();
    const label = date ? `${name} (${date})` : name;
    doneItems.push(`- [x] ${label}`);
  }
  columns["✅ Done"] = doneItems;

  // In Progress: currently empty — placeholder
  columns["🔄 In Progress"] = [];

  // Todo: "기존 과제" section unchecked items
  const todoSection = extractSectionContent(memoryText, "기존 과제", 3);
  if (todoSection) {
    columns["📋 Todo"] = extractCheckboxItems(todoSection, true);
  } else {
    columns["📋 Todo"] = [];
  }

  // Blocked: detect items containing blocking keywords
  const blockedItems: string[] = [];
  const blockPatterns = /대기|차단|blocked|미제공|미구현|확보 대기/i;
  // Scan entire text for lines that look like task items with blocking keywords
  for (const line of memoryText.split("\n")) {
    if (blockPatterns.test(line) && /^\s*-\s*\[[ x]\]/.test(line)) {
      // Skip already-completed items (strikethrough ~~...~~)
      if (/~~.+~~/.test(line)) continue;
      blockedItems.push(line.replace(/^\s*-\s*\[[ x]\]/, "- [ ]").trim());
    }
  }
  // Also check for CAVD API status paragraph
  if (
    memoryText.includes("API 키 확보 대기") ||
    memoryText.includes("공개 REST API 미제공")
  ) {
    const cavdBlocked = "- [ ] CAVD API 키 확보 대기 (CATARC 협약 필요)";
    if (!blockedItems.some((i) => i.includes("CAVD"))) {
      blockedItems.push(cavdBlocked);
    }
  }
  columns["🔴 Blocked"] = blockedItems;

  return columns;
}

function extractBeautyKanbanColumns(memoryText: string): KanbanColumns {
  const columns: KanbanColumns = {};

  // -----------------------------------------------------------------------
  // Done: Collect [x] items from multiple sources (most recent 8)
  // -----------------------------------------------------------------------
  const doneItems: string[] = [];

  // Source 1: "🔵 완료" section (legacy, e.g. "🔵 완료 (2026-02-03)")
  const nextActionText = extractSectionContent(memoryText, "다음 액션") ?? "";
  const completedHeadingMatch = nextActionText.match(
    /^###\s+(🔵\s+완료(?:\s*\([^)]+\))?)\s*$/m,
  );
  if (completedHeadingMatch) {
    const headingText = completedHeadingMatch[1].trim();
    const completedSection = extractSectionContent(
      `## dummy\n${nextActionText}`,
      headingText,
      3,
    );
    if (completedSection) {
      const checked = completedSection
        .split("\n")
        .filter((line) => /^\s*-\s*\[x\]/i.test(line));
      doneItems.push(...checked);
    }
  }

  // Source 2: Date sections (### 2026-MM-DD) — bold [x] items (key milestones)
  const dateSectionPattern = /^###\s+2026-\d{2}-\d{2}/gm;
  let dateMatch: RegExpExecArray | null;
  while ((dateMatch = dateSectionPattern.exec(memoryText)) !== null) {
    const startIdx = dateMatch.index;
    const rest = memoryText.slice(startIdx + dateMatch[0].length);
    const nextHeading = rest.search(/^#{1,3}\s/m);
    const sectionText =
      nextHeading === -1 ? rest : rest.slice(0, nextHeading);
    const checked = sectionText
      .split("\n")
      .filter((line) => /^\s*-\s*\[x\]\s+\*\*/.test(line));
    doneItems.push(...checked);
  }

  // Source 3: "🎊" milestone lines (e.g. Admin v1.0.0)
  const milestoneLines = memoryText
    .split("\n")
    .filter((line) => /^###\s+🎊/.test(line));
  for (const ml of milestoneLines) {
    doneItems.push(`- [x] ${ml.replace(/^#+\s*/, "")}`);
  }

  // Deduplicate by trimmed text, keep last 8
  const seen = new Set<string>();
  const uniqueDone = doneItems.filter((item) => {
    const key = item.replace(/^\s*-\s*\[x\]\s*/i, "").trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  columns["✅ Done"] = uniqueDone.slice(-8);

  // -----------------------------------------------------------------------
  // In Progress: currently empty placeholder
  // -----------------------------------------------------------------------
  columns["🔄 In Progress"] = [];

  // -----------------------------------------------------------------------
  // Todo: "🟢 다음 단계" unchecked + Phase C/D style unchecked items
  // -----------------------------------------------------------------------
  const todoItems: string[] = [];
  const nextActionSection = extractSectionContent(memoryText, "다음 액션");
  if (nextActionSection) {
    const nextSection = extractSectionContent(
      `## dummy\n${nextActionSection}`,
      "🟢 다음 단계",
      3,
    );
    if (nextSection) {
      todoItems.push(...extractCheckboxItems(nextSection, true));
    }
  }

  // Capture unchecked [ ] items that are Phase/pending tasks from date sections
  const allLines = memoryText.split("\n");
  for (const line of allLines) {
    if (
      /^\s*-\s*\[\s\]\s+\*\*Phase\s+[C-Z]/i.test(line) ||
      /^\s*-\s*\[\s\]\s+\*\*.*⏳/.test(line)
    ) {
      todoItems.push(line.trim());
    }
  }

  // Deduplicate
  const seenTodo = new Set<string>();
  columns["📋 Todo"] = todoItems.filter((item) => {
    const key = item.replace(/^\s*-\s*\[\s?\]\s*/i, "").trim();
    if (seenTodo.has(key)) return false;
    seenTodo.add(key);
    return true;
  });

  // -----------------------------------------------------------------------
  // Waiting (지니): "🟡 지니 액션 필요" unchecked items
  // -----------------------------------------------------------------------
  if (nextActionSection) {
    const jiniSection = extractSectionContent(
      `## dummy\n${nextActionSection}`,
      "🟡 지니 액션 필요",
      3,
    );
    if (jiniSection) {
      columns["🟡 Waiting (지니)"] = extractCheckboxItems(jiniSection, true);
    } else {
      columns["🟡 Waiting (지니)"] = [];
    }
  } else {
    columns["🟡 Waiting (지니)"] = [];
  }

  // -----------------------------------------------------------------------
  // Blocked: detect Zalo and other blocking patterns
  // -----------------------------------------------------------------------
  const blockedItems: string[] = [];
  const blockPatterns = /대기|차단|blocked|⚠️.*필요|번호 필요/i;
  for (const line of allLines) {
    if (blockPatterns.test(line) && /^\s*-\s*\[\s\]/.test(line)) {
      blockedItems.push(line.trim());
    }
  }
  columns["🔴 Blocked"] = blockedItems;

  return columns;
}

function buildKanbanContent(columns: KanbanColumns): string {
  const lines: string[] = [];

  // Frontmatter for Obsidian Kanban plugin
  lines.push("---");
  lines.push("kanban-plugin: basic");
  lines.push("---");
  lines.push("");

  // Column order matters for Kanban display
  const columnOrder = [
    "✅ Done",
    "🔄 In Progress",
    "📋 Todo",
    "🟡 Waiting (지니)",
    "🔴 Blocked",
  ];

  for (const colName of columnOrder) {
    if (!(colName in columns)) continue;

    lines.push(`## ${colName}`);
    lines.push("");
    const items = columns[colName];
    if (items.length > 0) {
      for (const item of items) {
        // Ensure proper checkbox format
        const normalized = item.startsWith("- [")
          ? item
          : `- [ ] ${item}`;
        lines.push(normalized);
      }
    }
    lines.push("");
  }

  const today = new Date().toISOString().slice(0, 10);
  lines.push(`%% Auto-generated by MAIBOT on ${today} %%`);
  lines.push("");

  return lines.join("\n");
}

async function writeKanbanFile(
  vaultPath: string,
  kanbanRelPath: string,
  content: string,
): Promise<boolean> {
  const filePath = path.join(vaultPath, kanbanRelPath);

  // Ensure directory exists
  const dir = path.dirname(filePath);
  if (!(await pathExists(dir))) {
    console.warn(`  [skip] kanban directory not found: ${dir}`);
    return false;
  }

  // Check if content changed
  let existing = "";
  try {
    existing = await readFile(filePath, "utf-8");
  } catch {
    // File doesn't exist yet — will create
  }

  if (existing === content) {
    console.log(`  [no change] ${kanbanRelPath}`);
    return false;
  }

  await writeFile(filePath, content);
  console.log(`  [updated] ${kanbanRelPath}`);
  return true;
}

// ---------------------------------------------------------------------------
// Section builder (for dashboard updates)
// ---------------------------------------------------------------------------

function buildSection(
  memoryFile: string,
  sectionName: string,
  memoryText: string,
): string[] {
  if (memoryFile === "MEMORY.md") {
    if (sectionName === "active-projects") {
      return extractMasterActiveProjects(memoryText);
    }
  }

  if (memoryFile === "memory/maioss.md") {
    switch (sectionName) {
      case "milestones":
        return extractMaiossMilestones(memoryText);
      case "open-tasks":
        return extractMaiossOpenTasks(memoryText);
      case "decisions":
        return extractMaiossDecisions(memoryText);
      case "test-health":
        return extractMaiossTestHealth(memoryText);
    }
  }

  if (memoryFile === "memory/vietnam-beauty.md") {
    switch (sectionName) {
      case "ai-models":
        return extractBeautyAiModels(memoryText);
      case "admin-phases":
        return extractBeautyAdminPhases(memoryText);
      case "open-tasks":
        return extractBeautyOpenTasks(memoryText);
      case "decisions":
        return extractBeautyDecisions(memoryText);
    }
  }

  return [];
}

main().catch((err) => {
  console.error("[sync-obsidian] error:", err);
  process.exit(0); // Never block git workflow
});
