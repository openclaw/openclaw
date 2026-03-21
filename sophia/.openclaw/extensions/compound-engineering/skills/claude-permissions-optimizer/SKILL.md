---
name: claude-permissions-optimizer
context: fork
description: Optimize Claude Code permissions by finding safe Bash commands from session history and auto-applying them to settings.json. Can run from any coding agent but targets Claude Code specifically. Use when experiencing permission fatigue, too many permission prompts, wanting to optimize permissions, or needing to set up allowlists. Triggers on "optimize permissions", "reduce permission prompts", "allowlist commands", "too many permission prompts", "permission fatigue", "permission setup", or complaints about clicking approve too often.
---

# Claude Permissions Optimizer

Find safe Bash commands that are causing unnecessary permission prompts and auto-allow them in `settings.json` -- evidence-based, not prescriptive.

This skill identifies commands safe to auto-allow based on actual session history. It does not handle requests to allowlist specific dangerous commands. If the user asks to allow something destructive (e.g., `rm -rf`, `git push --force`), explain that this skill optimizes for safe commands only, and that manual allowlist changes can be made directly in settings.json.

## Pre-check: Confirm environment

Determine whether you are currently running inside Claude Code or a different coding agent (Codex, Gemini CLI, Cursor, etc.).

**If running inside Claude Code:** Proceed directly to Step 1.

**If running in a different agent:** Inform the user before proceeding:

> "This skill analyzes Claude Code session history and writes to Claude Code's settings.json. You're currently in [agent name], but I can still optimize your Claude Code permissions from here -- the results will apply next time you use Claude Code."

Then proceed to Step 1 normally. The skill works from any environment as long as `~/.openclaw/` (or `$CLAUDE_CONFIG_DIR`) exists on the machine.

## Step 1: Choose Analysis Scope

Ask the user how broadly to analyze using the platform's blocking question tool (`AskUserQuestion` in Claude Code, `request_user_input` in Codex, `ask_user` in Gemini). If no question tool is available, present the numbered options and wait for the user's reply.

1. **All projects** (Recommended) -- sessions across every project
2. **This project only** -- sessions for the current working directory
3. **Custom** -- user specifies constraints (time window, session count, etc.)

Default to **All projects** unless the user explicitly asks for a single project. More data produces better recommendations.

## Step 2: Run Extraction Script

Run the bundled script. It handles everything: loads the current allowlist, scans recent session transcripts (most recent 500 sessions or last 30 days, whichever is more restrictive), filters already-covered commands, applies a min-count threshold (5+), normalizes into `Bash(pattern)` rules, and pre-classifies each as safe/review/dangerous.

**All projects:**
```bash
node <skill-dir>/scripts/extract-commands.mjs
```

**This project only** -- pass the project slug (absolute path with every non-alphanumeric char replaced by `-`, e.g., `/Users/tmchow/Code/my-project` becomes `-Users-tmchow-Code-my-project`):
```bash
node <skill-dir>/scripts/extract-commands.mjs --project-slug <slug>
```

Optional: `--days <N>` to limit to the last N days. Omit to analyze all available sessions.

The output JSON has:
- `green`: safe patterns to recommend `{ pattern, count, sessions, examples }`
- `redExamples`: top 5 blocked dangerous patterns `{ pattern, reason, count }` (or empty)
- `yellowFootnote`: one-line summary of frequently-used commands that aren't safe to auto-allow (or null)
- `stats`: `totalExtracted`, `alreadyCovered`, `belowThreshold`, `patternsReturned`, `greenRawCount`, etc.

The model's job is to **present** the script's output, not re-classify.

If the script returns empty results, tell the user their allowlist is already well-optimized or they don't have enough session history yet -- suggest re-running after a few more working sessions.

## Step 3: Present Results

Present in three parts. Keep the formatting clean and scannable.

### Part 1: Analysis summary

Show the work done using the script's `stats`. Reaffirm the scope. Keep it to 4-5 lines.

**Example:**
```
## Analysis (compound-engineering-plugin)

Scanned **24 sessions** for this project.
Found **312 unique Bash commands** across those sessions.

- **245** already covered by your 43 existing allowlist rules (79%)
- **61** used fewer than 5 times (filtered as noise)
- **6 commands** remain that regularly trigger permission prompts
```

### Part 2: Recommendations

Present `green` patterns as a numbered table. If `yellowFootnote` is not null, include it as a line after the table.

```
### Safe to auto-allow
| # | Pattern | Evidence |
|---|---------|----------|
| 1 | `Bash(bun test *)` | 23 uses across 8 sessions |
| 2 | `Bash(bun run *)` | 18 uses, covers dev/build/lint scripts |
| 3 | `Bash(node *)` | 12 uses across 5 sessions |

Also frequently used: bun install, mkdir (not classified as safe to auto-allow but may be worth reviewing)
```

If `redExamples` is non-empty, show a compact "Blocked" table after the recommendations. This builds confidence that the classifier is doing its job. Show up to 3 examples.

```
### Blocked from recommendations
| Pattern | Reason | Uses |
|---------|--------|------|
| `rm *` | Irreversible file deletion | 21 |
| `eval *` | Arbitrary code execution | 14 |
| `git reset --hard *` | Destroys uncommitted work | 5 |
```

### Part 3: Bottom line

**One sentence only.** Frame the impact relative to current coverage using the script's stats. Nothing else -- no pattern names, no usage counts, no elaboration. The question tool UI that immediately follows will visually clip any trailing text, so this must fit on a single short line.

```
Adding 22 rules would bring your allowlist coverage from 65% to 93%.
```

Compute the percentages from stats:
- **Before:** `alreadyCovered / totalExtracted * 100`
- **After:** `(alreadyCovered + greenRawCount) / totalExtracted * 100`

Use `greenRawCount` (the number of unique raw commands the green patterns cover), not `patternsReturned` (which is just the number of normalized patterns).

## Step 4: Get User Confirmation

The recommendations table is already displayed. Use the platform's blocking question tool to ask for the decision:

1. **Apply all to user settings** (`~/.openclaw/settings.json`)
2. **Apply all to project settings** (`.openclaw/settings.json`)
3. **Skip**

If the user wants to exclude specific items, they can reply in free text (e.g., "all except 3 and 7 to user settings"). The numbered table is already visible for reference -- no need to re-list items in the question tool.

## Step 5: Apply to Settings

For each target settings file:

1. Read the current file (create `{ "permissions": { "allow": [] } }` if it doesn't exist)
2. Append new patterns to `permissions.allow`, avoiding duplicates
3. Sort the allow array alphabetically
4. Write back with 2-space indentation
5. **Verify the write** -- tell the user you're validating the JSON before running this command, e.g., "Verifying settings.json is valid JSON..." The command looks alarming without context:
   ```bash
   node -e "JSON.parse(require('fs').readFileSync('<path>','utf8'))"
   ```
   If this fails, the file is invalid JSON. Immediately restore from the content read in step 1 and report the error. Do not continue to other files.

After successful verification:

```
Applied N rules to ~/.openclaw/settings.json
Applied M rules to .openclaw/settings.json

These commands will no longer trigger permission prompts.
```

If `.openclaw/settings.json` was modified and is tracked by git, mention that committing it would benefit teammates.

## Edge Cases

- **No project context** (running outside a project): Only offer user-level settings as write target.
- **Settings file doesn't exist**: Create it with `{ "permissions": { "allow": [] } }`. For `.openclaw/settings.json`, also create the `.openclaw/` directory if needed.
- **Deny rules**: If a deny rule already blocks a command, warn rather than adding an allow rule (deny takes precedence in Claude Code).
