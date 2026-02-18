#!/usr/bin/env bun
/**
 * docs-sync-korean.ts
 *
 * Syncs Korean translations with English doc changes from main.
 * Uses git diff to detect changes and Claude API for 3-way merge translation.
 *
 * Usage:
 *   bun scripts/docs-sync-korean.ts [options]
 *
 * Options:
 *   --dry-run          Show what would be synced without making changes
 *   --max <n>          Limit number of files to process (default: unlimited)
 *   --file <path>      Sync a specific file only (repeatable)
 *   --no-pr            Skip PR creation (just write files)
 *   --base-sha <sha>   Override the last sync SHA
 *   --provider <name>  Force provider: "openai" or "anthropic" (auto-detected from env)
 *   --model <model>    Model to use (default: gpt-4o / claude-sonnet-4-5)
 *   --verbose          Show detailed output
 *
 * Environment:
 *   OPENAI_API_KEY     OpenAI API key (auto-selects OpenAI provider)
 *   ANTHROPIC_API_KEY  Anthropic API key (auto-selects Anthropic provider)
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dirname, "..");
const GLOSSARY_PATH = resolve(REPO_ROOT, "docs/.i18n/glossary.ko-KR.json");
const SYNC_STATE_PATH = resolve(REPO_ROOT, "docs/.i18n/sync-state.ko-KR.json");
const SOURCE_BRANCH = "main";
const TARGET_BRANCH = "korean";
const DEFAULT_MODEL_ANTHROPIC = "claude-sonnet-4-5-20250929";
const DEFAULT_MODEL_OPENAI = "gpt-4o";

// Korean translations live under docs/ko-KR/ mirroring docs/ structure
// e.g. docs/automation/cron-jobs.md → docs/ko-KR/automation/cron-jobs.md
const KO_PREFIX = "docs/ko-KR/";

// Files/dirs to skip when scanning English source changes
const SKIP_PATTERNS = ["/zh-CN/", "/ko-KR/", "/es/", "/pt-BR/", "/.i18n/"];

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

type Provider = "anthropic" | "openai";

interface Options {
  dryRun: boolean;
  max: number;
  files: string[];
  noPr: boolean;
  baseSha: string | null;
  model: string;
  provider: Provider;
  verbose: boolean;
}

function detectProvider(): { provider: Provider; model: string } {
  if (process.env.ANTHROPIC_API_KEY) {
    return { provider: "anthropic", model: DEFAULT_MODEL_ANTHROPIC };
  }
  if (process.env.OPENAI_API_KEY) {
    return { provider: "openai", model: DEFAULT_MODEL_OPENAI };
  }
  console.error(
    "Error: No API key found.\n" +
      "Set one of:\n" +
      "  export OPENAI_API_KEY=sk-...\n" +
      "  export ANTHROPIC_API_KEY=sk-ant-...\n",
  );
  process.exit(1);
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const detected = detectProvider();
  const opts: Options = {
    dryRun: false,
    max: Infinity,
    files: [],
    noPr: false,
    baseSha: null,
    model: detected.model,
    provider: detected.provider,
    verbose: false,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--max":
        opts.max = parseInt(args[++i], 10);
        break;
      case "--file":
        opts.files.push(args[++i]);
        break;
      case "--no-pr":
        opts.noPr = true;
        break;
      case "--base-sha":
        opts.baseSha = args[++i];
        break;
      case "--model":
        opts.model = args[++i];
        break;
      case "--provider":
        opts.provider = args[++i] as Provider;
        break;
      case "--verbose":
        opts.verbose = true;
        break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        process.exit(1);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function git(cmd: string): string {
  return execSync(`git ${cmd}`, { cwd: REPO_ROOT, encoding: "utf-8" }).trim();
}

function gitShow(ref: string, filepath: string): string | null {
  try {
    return execSync(`git show ${ref}:${filepath}`, {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    });
  } catch {
    return null;
  }
}

function getMergeBase(): string {
  return git(`merge-base ${SOURCE_BRANCH} ${TARGET_BRANCH}`);
}

/** Convert English doc path to ko-KR path: docs/foo.md → docs/ko-KR/foo.md */
function toKoPath(enPath: string): string {
  return enPath.replace(/^docs\//, KO_PREFIX);
}

interface FileChange {
  status: "A" | "M" | "D" | "R";
  file: string;
  renamedFrom?: string;
}

function getChangedFiles(baseSha: string): FileChange[] {
  const raw = git(
    `diff --diff-filter=ADMR --name-status ${baseSha}..${SOURCE_BRANCH} -- "docs/**/*.md" "docs/**/*.mdx"`,
  );
  if (!raw) {
    return [];
  }

  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      const statusChar = parts[0][0] as FileChange["status"];
      if (statusChar === "R") {
        return { status: "R", renamedFrom: parts[1], file: parts[2] };
      }
      return { status: statusChar, file: parts[1] };
    })
    .filter((c) => !SKIP_PATTERNS.some((p) => c.file.includes(p)));
}

// ---------------------------------------------------------------------------
// Sync state
// ---------------------------------------------------------------------------

interface SyncState {
  last_sync_sha: string;
  last_sync_date: string;
  synced_files: Record<string, { sha: string; synced_at: string }>;
}

function loadSyncState(): SyncState {
  try {
    return JSON.parse(readFileSync(SYNC_STATE_PATH, "utf-8"));
  } catch {
    return {
      last_sync_sha: getMergeBase(),
      last_sync_date: new Date().toISOString(),
      synced_files: {},
    };
  }
}

function saveSyncState(state: SyncState): void {
  mkdirSync(dirname(SYNC_STATE_PATH), { recursive: true });
  writeFileSync(SYNC_STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Glossary
// ---------------------------------------------------------------------------

interface GlossaryEntry {
  source: string;
  target: string;
}

function loadGlossary(): GlossaryEntry[] {
  try {
    return JSON.parse(readFileSync(GLOSSARY_PATH, "utf-8"));
  } catch {
    return [];
  }
}

function formatGlossary(entries: GlossaryEntry[]): string {
  if (entries.length === 0) {
    return "";
  }
  const lines = entries.map((e) => `  "${e.source}" → "${e.target}"`);
  return `Preferred translations (use these consistently):\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// LLM API (supports both OpenAI and Anthropic — no SDK dependency needed)
// ---------------------------------------------------------------------------

interface LLMMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/** Strip accidental code-fence wrapping that LLMs sometimes add (e.g. ```markdown ... ```) */
function stripCodeFenceWrapper(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```[a-z]*\n([\s\S]*?)```\s*$/);
  if (match) {
    return match[1].trimEnd() + "\n";
  }
  return text;
}

async function callLLM(
  provider: Provider,
  model: string,
  system: string,
  messages: LLMMessage[],
  maxTokens = 16384,
): Promise<string> {
  const raw =
    provider === "openai"
      ? await callOpenAI(model, system, messages, maxTokens)
      : await callAnthropic(model, system, messages, maxTokens);
  return stripCodeFenceWrapper(raw);
}

async function callOpenAI(
  model: string,
  system: string,
  messages: LLMMessage[],
  maxTokens: number,
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY environment variable is required.");
  }

  const allMessages = [{ role: "system" as const, content: system }, ...messages];

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: allMessages,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${body}`);
  }

  const data = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  return data.choices[0]?.message?.content ?? "";
}

async function callAnthropic(
  model: string,
  system: string,
  messages: LLMMessage[],
  maxTokens: number,
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY environment variable is required.");
  }

  // Anthropic doesn't use "system" role in messages — it's a top-level field
  const anthropicMessages = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: anthropicMessages,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${body}`);
  }

  const data = (await res.json()) as {
    content: Array<{ type: string; text?: string }>;
  };
  const textBlocks = data.content.filter((b) => b.type === "text" && b.text);
  return textBlocks.map((b) => b.text!).join("");
}

// ---------------------------------------------------------------------------
// Translation prompts
// ---------------------------------------------------------------------------

function buildSystemPrompt(glossary: string): string {
  return `You are a Korean technical documentation translator. You translate English documentation to Korean with high accuracy.

Rules:
- Output ONLY the translated/updated markdown document. No preamble, no commentary, no wrapping.
- Preserve all markdown formatting exactly (headings, lists, tables, code blocks, emphasis, links).
- Preserve frontmatter YAML structure; translate only human-readable values (title, summary, read_when items).
- Do NOT translate: code blocks, inline code, CLI commands, config keys, env vars, URLs, anchors, file paths.
- Do NOT alter link targets or anchor references.
- Use fluent, idiomatic Korean technical writing style.
- Insert a space between Latin/ASCII characters and Korean text (e.g., "Gateway 게이트웨이", "CLI 명령어").
- Keep product names in English: OpenClaw, Pi, WhatsApp, Telegram, Discord, iMessage, Slack, Microsoft Teams, Google Chat, Signal, Tailscale.
- Keep abbreviations as-is: CLI, API, SDK, URL, SSH, HTTP, HTTPS, DNS, IP, TCP, UDP, TLS, SSL.
- Never output an empty response; if unsure, return the source text unchanged.

${glossary}`.trim();
}

function buildSyncPrompt(oldEn: string, newEn: string, curKo: string): string {
  return `The English source document has been updated. Update the Korean translation to match.

## Previous English version
<old_english>
${oldEn}
</old_english>

## Current English version (updated)
<new_english>
${newEn}
</new_english>

## Current Korean translation (based on previous English)
<current_korean>
${curKo}
</current_korean>

## Instructions
1. Compare the old and new English to identify what changed (additions, modifications, deletions).
2. For sections UNCHANGED between old and new English: keep the existing Korean translation EXACTLY as-is (character-for-character).
3. For sections ADDED in the new English: translate them to Korean.
4. For sections MODIFIED in the new English: update the Korean translation to match.
5. For sections REMOVED from the new English: remove them from the Korean output.
6. Output the complete updated Korean document.`;
}

function buildFullTranslatePrompt(en: string): string {
  return `Translate the following English documentation to Korean.

<english>
${en}
</english>

Output the complete Korean translation.`;
}

// ---------------------------------------------------------------------------
// File processing
// ---------------------------------------------------------------------------

async function processModifiedFile(
  file: string,
  baseSha: string,
  provider: Provider,
  model: string,
  glossary: string,
  verbose: boolean,
  /** For renamed files, pass the old path to read old English and current Korean */
  oldFilePath?: string,
): Promise<string | null> {
  const oldEn = gitShow(baseSha, oldFilePath || file);
  const newEn = gitShow(SOURCE_BRANCH, file);
  // Korean translations live under docs/ko-KR/ mirroring the English path
  const koFile = toKoPath(oldFilePath || file);
  const curKo = gitShow(TARGET_BRANCH, koFile);

  if (!newEn) {
    if (verbose) {
      console.log(`  [skip] Cannot read ${file} from ${SOURCE_BRANCH}`);
    }
    return null;
  }

  // If Korean file doesn't exist yet, do a full translation
  if (!curKo) {
    if (verbose) {
      console.log(`  [new] Full translation (no Korean version exists)`);
    }
    return callLLM(provider, model, buildSystemPrompt(glossary), [
      { role: "user", content: buildFullTranslatePrompt(newEn) },
    ]);
  }

  // If old English is same as new (shouldn't happen but safety check)
  if (oldEn === newEn) {
    if (verbose) {
      console.log(`  [skip] No actual content change`);
    }
    return null;
  }

  // 3-way merge: old EN + new EN + current KO → updated KO
  if (verbose) {
    console.log(`  [sync] 3-way merge translation`);
  }
  return callLLM(provider, model, buildSystemPrompt(glossary), [
    { role: "user", content: buildSyncPrompt(oldEn || "", newEn, curKo) },
  ]);
}

async function processNewFile(
  file: string,
  provider: Provider,
  model: string,
  glossary: string,
  verbose: boolean,
): Promise<string | null> {
  const newEn = gitShow(SOURCE_BRANCH, file);
  if (!newEn) {
    return null;
  }

  if (verbose) {
    console.log(`  [new] Full translation`);
  }
  return callLLM(provider, model, buildSystemPrompt(glossary), [
    { role: "user", content: buildFullTranslatePrompt(newEn) },
  ]);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();
  const glossaryEntries = loadGlossary();
  const glossary = formatGlossary(glossaryEntries);
  const syncState = loadSyncState();
  const baseSha = opts.baseSha || syncState.last_sync_sha;

  console.log(`\n📋 docs-sync-korean`);
  console.log(`   Provider:  ${opts.provider}`);
  console.log(`   Base SHA:  ${baseSha.slice(0, 10)}`);
  console.log(`   Model:     ${opts.model}`);
  console.log(`   Glossary:  ${glossaryEntries.length} entries`);
  if (opts.dryRun) {
    console.log(`   Mode:      DRY RUN`);
  }
  console.log();

  // Detect changes
  let changes: FileChange[];
  if (opts.files.length > 0) {
    // Manual file selection — treat all as modified
    changes = opts.files.map((f) => ({ status: "M" as const, file: f }));
  } else {
    changes = getChangedFiles(baseSha);
  }

  if (changes.length === 0) {
    console.log("No doc changes detected. Everything is in sync!");
    return;
  }

  // Apply --max limit
  if (opts.max < changes.length) {
    changes = changes.slice(0, opts.max);
  }

  const added = changes.filter((c) => c.status === "A");
  const modified = changes.filter((c) => c.status === "M");
  const deleted = changes.filter((c) => c.status === "D");
  const renamed = changes.filter((c) => c.status === "R");

  console.log(`📊 Changes detected:`);
  console.log(`   Added:    ${added.length}`);
  console.log(`   Modified: ${modified.length}`);
  console.log(`   Deleted:  ${deleted.length}`);
  console.log(`   Renamed:  ${renamed.length}`);
  console.log(`   Total:    ${changes.length}`);
  console.log();

  if (opts.dryRun) {
    console.log("Files to sync (English source → ko-KR target):");
    for (const c of changes) {
      const label = { A: "ADD", M: "MOD", D: "DEL", R: "REN" }[c.status];
      console.log(`  [${label}] ${c.file} → ${toKoPath(c.file)}`);
    }
    return;
  }

  // Process files
  const mainSha = git(`rev-parse ${SOURCE_BRANCH}`);
  const now = new Date().toISOString();
  let processed = 0;
  let errors = 0;

  for (const change of changes) {
    const idx = changes.indexOf(change) + 1;
    console.log(`[${idx}/${changes.length}] ${change.file} (${change.status})`);

    try {
      // Output goes to docs/ko-KR/ mirroring the English path
      const koFile = toKoPath(change.file);
      const koFilePath = resolve(REPO_ROOT, koFile);

      if (change.status === "D") {
        // Delete Korean file if it exists
        if (existsSync(koFilePath)) {
          unlinkSync(koFilePath);
          console.log(`  ✓ Deleted ${koFile}`);
        }
        processed++;
        continue;
      }

      let result: string | null = null;

      if (change.status === "A") {
        result = await processNewFile(
          change.file,
          opts.provider,
          opts.model,
          glossary,
          opts.verbose,
        );
      } else if (change.status === "R" && change.renamedFrom) {
        // For renamed files, delete the old Korean file and translate the new one
        const oldKoPath = resolve(REPO_ROOT, toKoPath(change.renamedFrom));
        if (existsSync(oldKoPath)) {
          unlinkSync(oldKoPath);
          if (opts.verbose) {
            console.log(`  [rename] Deleted old: ${toKoPath(change.renamedFrom)}`);
          }
        }
        result = await processModifiedFile(
          change.file,
          baseSha,
          opts.provider,
          opts.model,
          glossary,
          opts.verbose,
          change.renamedFrom,
        );
      } else {
        // M
        result = await processModifiedFile(
          change.file,
          baseSha,
          opts.provider,
          opts.model,
          glossary,
          opts.verbose,
        );
      }

      if (result) {
        // Write to docs/ko-KR/
        mkdirSync(dirname(koFilePath), { recursive: true });
        writeFileSync(koFilePath, result);
        console.log(`  ✓ Updated ${koFile} (${result.length} chars)`);
        processed++;

        // Update sync state for this file
        syncState.synced_files[change.file] = { sha: mainSha, synced_at: now };
      } else {
        console.log(`  - Skipped`);
      }
    } catch (err) {
      errors++;
      console.error(`  ✗ Error: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Rate limiting — small delay between API calls
    if (change.status !== "D") {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // Only save sync state if we actually processed files successfully
  if (processed > 0) {
    syncState.last_sync_sha = mainSha;
    syncState.last_sync_date = now;
    saveSyncState(syncState);
  }

  console.log(`\n✅ Sync complete: ${processed} files processed, ${errors} errors`);

  // Create PR unless --no-pr
  if (!opts.noPr && processed > 0) {
    console.log("\n🔀 Creating PR...");
    try {
      const branchName = `sync/korean-${new Date().toISOString().slice(0, 10)}`;
      git(`checkout -b ${branchName}`);
      git(`add docs/`);
      git(`add ${SYNC_STATE_PATH}`);

      const commitMsg = `docs(i18n): sync Korean translations to ${mainSha.slice(0, 10)}

Synced ${processed} files from main branch changes.
Base: ${baseSha.slice(0, 10)} → ${mainSha.slice(0, 10)}`;

      execSync(`git commit -m "$(cat <<'EOF'\n${commitMsg}\nEOF\n)"`, {
        cwd: REPO_ROOT,
        encoding: "utf-8",
      });

      git(`push -u origin ${branchName}`);

      const prBody = `## Summary
- Synced ${processed} Korean doc translations with latest English changes from main
- Base SHA: \`${baseSha.slice(0, 10)}\` → \`${mainSha.slice(0, 10)}\`
- Files: ${added.length} added, ${modified.length} modified, ${deleted.length} deleted
${errors > 0 ? `- ⚠️ ${errors} files had errors (check logs)` : ""}

## Changed files
${changes.map((c) => `- [${c.status}] \`${c.file}\``).join("\n")}

## Review checklist
- [ ] Spot-check translated content for accuracy
- [ ] Verify code blocks and links are preserved
- [ ] Check frontmatter values are correctly translated

🤖 Generated by \`scripts/docs-sync-korean.ts\``;

      const prUrl = execSync(
        `gh pr create --base ${TARGET_BRANCH} --title "docs(i18n): sync Korean translations (${new Date().toISOString().slice(0, 10)})" --body "$(cat <<'PREOF'\n${prBody}\nPREOF\n)"`,
        { cwd: REPO_ROOT, encoding: "utf-8" },
      ).trim();

      console.log(`✅ PR created: ${prUrl}`);

      // Go back to the original branch
      git(`checkout ${TARGET_BRANCH}`);
    } catch (err) {
      console.error(`Failed to create PR: ${err instanceof Error ? err.message : String(err)}`);
      console.log("Changes have been written to the working tree. You can commit manually.");
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
