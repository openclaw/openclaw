<!-- Authored by: cc (Claude Code) | 2026-03-13 -->

# Claude Code Token Efficiency Playbook

You are an AI coding agent working on the OpenClaw repo. This playbook supplements AGENTS.md with token efficiency patterns. Follow these directives to minimize wasted context and maximize output quality per turn.

<context>

## Token Budget Reference

| Asset                        | Tokens |
| ---------------------------- | ------ |
| CLAUDE.md / AGENTS.md        | ~3,000 |
| docs/repo-map.json           | ~1,500 |
| docs/architecture_summary.md | ~600   |
| TypeScript file (300 LOC)    | ~2,000 |
| Test file (200 LOC)          | ~1,200 |
| Prompt template              | ~300   |
| Git diff (typical PR)        | ~1,000 |

Per-turn budget: ~22k tokens (system + repo map + 5 source files + response).

## Model Tiering Reference

| Task                             | Model  | Flag                        |
| -------------------------------- | ------ | --------------------------- |
| Classify, triage, summarize logs | Haiku  | `--model claude-haiku-4-5`  |
| Code gen, review, tests          | Sonnet | `--model claude-sonnet-4-5` |
| Architecture, complex refactors  | Opus   | `--model claude-opus-4-5`   |

## Prompt Templates Reference

Templates live in `prompts/`. Variables use `{VARIABLE_NAME}`.

| Template  | File                          | Use                |
| --------- | ----------------------------- | ------------------ |
| Implement | `prompts/implement-issue.txt` | Issue to code      |
| Debug     | `prompts/debug-issue.txt`     | Error diagnosis    |
| Test      | `prompts/write-test.txt`      | Vitest generation  |
| Refactor  | `prompts/refactor.txt`        | Scoped refactoring |
| Review    | `prompts/review-diff.txt`     | Diff review        |

```bash
TEMPLATE=$(cat prompts/implement-issue.txt)
PROMPT="${TEMPLATE//\{ISSUE_URL\}/$ISSUE_URL}"
echo "$PROMPT" | claude --model claude-sonnet-4-5
```

## Local Search Patterns Reference

```bash
rg "export (async )?function handleCall" --type ts   # definition
rg "from ['\"].*gateway/auth" --type ts               # importers
rg -l "describe.*auth" --glob "*.test.ts"             # test files
pnpm tsgo 2>&1 | head -20                             # type errors
```

## Context Compression Patterns Reference

- Strip comments: `grep -v "^\s*//" src/file.ts`
- Narrow diffs: `git diff --unified=1 src/file.ts`
- Signatures only: `rg "^export (async )?(function|const|class) " src/file.ts`

## Autonomous Agent Loop Reference

See `scripts/run-issue.sh`. Structure: fetch issue -> decompose (Haiku) -> implement per-step (Sonnet) -> `pnpm build` between steps -> `pnpm test` at end -> `gh pr create`.

Safety: max 3 retries/step, no force-push, `pnpm check` before PR.

</context>

<rules>

## 1. File Discovery

Read `docs/repo-map.json` before searching `src/` or `extensions/`. The map indexes files by purpose, exports, and dependencies. This avoids burning tokens on directory traversal when the map already answers "where is X?"

Update the map when adding major modules.

## 2. Architecture Awareness

Read `docs/architecture_summary.md` before multi-file changes. Understanding module boundaries prevents cross-cutting edits that break unrelated code.

## 3. Context Guardrails

**Hard limits** — abort and decompose if exceeded:

1. Max 5 file reads per turn
2. Max 200 lines per response
3. If task touches 10+ files, decompose before starting

**Soft limits:**

- Use `rg` to locate symbols instead of reading whole files — local search is free, model tokens are not
- Ask for clarification rather than guessing module boundaries — wrong guesses waste an entire turn

**Context exhaustion recovery:** Start new session with compact handoff: task, completed files, remaining steps, key decisions.

## 4. Issue Workflow

```bash
git checkout -b feature/{NUMBER}-{SLUG}
# Implement one file at a time, verify between files
pnpm build && pnpm check && pnpm test
scripts/committer "{scope}: {description} (#{NUMBER})" {files...}
gh pr create --title "{scope}: {description}" --body "Closes #{NUMBER}"
```

## 5. Chunked Refactoring

Large refactors exceed context limits in one shot. Break into chunks of 3-5 files, each independently buildable, so failures are caught early and don't cascade:

1. Define new interfaces/types -> verify: `pnpm tsgo`
2. Update core implementation -> verify: `pnpm build`
3. Migrate callers -> verify: `pnpm build`
4. Update tests -> verify: `pnpm test`

## 6. Log Pre-Summarization

Raw test/build output wastes tokens because most lines are passing tests. Filter to failures first, summarize with a cheap model, then fix with an accurate model:

```bash
pnpm test 2>&1 | grep -A 5 "FAIL\|Error" > /tmp/failures.log
claude --model claude-haiku-4-5 "Summarize: file, test, expected vs actual" < /tmp/failures.log > /tmp/summary.txt
claude --model claude-sonnet-4-5 "Fix these. Diff-only." < /tmp/summary.txt
```

Pre-summarize when: test output > 100 lines, build errors > 50 lines, lint > 30 warnings.

## 7. Permanent Context Discipline

CLAUDE.md loads every session. Keep it to: stack identity, build commands, module boundaries, commit conventions, hard constraints. Ephemeral task context goes in the prompt, not CLAUDE.md, because CLAUDE.md tokens are paid on every turn.

## 8. Red Flags

Stop and reassess if any of these occur — they indicate a blown context budget:

- Reading 10+ files in one turn
- Response exceeding 300 lines
- Repeated reads of the same file across turns
- Returning full file contents instead of targeted edits

</rules>
