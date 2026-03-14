<!-- Authored by: cc (Claude Code) | 2026-03-13 -->
# Arry8 OpenClaw Dev Fork

<context>

## Repository
- **Fork**: https://github.com/Arry8/openclaw (origin)
- **Upstream**: https://github.com/openclaw/openclaw (upstream)
- **Local**: ~/Developer/openclaw
- **Upstream conventions**: see root CLAUDE.md (symlinked to AGENTS.md)

## Instance
- Barry's running OC instance: ~/.openclaw/
- This repo is the upstream source code, separate from the instance config

## Stack
- TypeScript (ESM), Node 22+, pnpm 10.x, Bun for TS execution
- Build: tsdown, Vitest for tests, Oxlint + Oxfmt for lint/format
- Extensions/plugins in extensions/*, skills in skills/*

</context>

<rules>

## Dev Workflow

### Sync
- Always sync with upstream before starting work: `git fetch upstream && git rebase upstream/main`

### Issues
- Plan improvements as GitHub issues on Arry8/openclaw using the `improvement` template
- Template fields match token strategy Section 3: Summary, Problem, Acceptance Criteria, Implementation Plan, Files Affected
- Quick issues: `gh issue create --repo Arry8/openclaw --title "..." --body "..."`

### Branching
- Feature branches from main: `feature/<issue#>-<slug>` (e.g. `feature/12-rate-limiter`)
- One issue per branch, one branch per PR

### Implementation
- Use prompt templates in `prompts/` (implement-issue, debug-issue, write-test, refactor, review-diff)
- Test before PR: `pnpm build && pnpm check && pnpm test`
- Keep PRs focused — one change per PR

### Pull Requests (fork workflow)
1. Push feature branch, open **draft PR** on Arry8/openclaw (feature → main)
2. CodeRabbit reviews on draft creation — fix findings as you go
3. All issues addressed → mark PR **"ready for review"** → final CodeRabbit pass
4. Three review-fix cycles max on final review
5. Squash merge to Arry8/main

### Upstream Contributions
- Case-by-case: PR from Arry8/main → openclaw/openclaw main
- Mark as AI-assisted in PR body
- Use upstream PR template (`.github/pull_request_template.md`)
- Follow upstream commit style: concise, action-oriented (e.g. `CLI: add verbose flag`)

## Authorship
- Follow Barry's authorship tag convention from ~/CLAUDE.md
- Follow upstream commit style: concise, action-oriented (e.g., `CLI: add verbose flag`)

## Cross-Reference
- For upstream repo conventions (coding style, testing, PRs): read root CLAUDE.md / AGENTS.md
- For Barry's OC instance config/operations: read ~/.openclaw/CLAUDE.md
- For the full token efficiency playbook (14 sections): read `docs/claude-workflow.md`

## Token Efficiency (Mandatory)

### File Discovery
- **MUST read `docs/repo-map.json` before searching `src/` or `extensions/`.** The repo map has curated file purposes, exports, and dependencies. Use it to identify target files, then read only those files. Do not glob/grep the full tree when the repo map answers the question.
- **MUST read `docs/architecture_summary.md` before multi-file changes.** Understand module boundaries and data flows before proposing cross-module edits.

### Implementation Discipline
- **Chunked builds**: For changes touching 5+ files, implement in chunks of 3-5 files. Run `pnpm build` between chunks. Never attempt a full codebase refactor in one turn.
- **Deterministic-first**: Before reasoning about code, use local tools first: `rg` for search, `pnpm tsgo` for type errors, `pnpm test` for failures. Feed concrete error output to the model, not vague descriptions.
- **Context budget**: Keep per-turn source reads under 5 files (~10k tokens). If a task requires more, decompose into subtasks with handoff summaries between them.

### Prompt Templates
- Reusable templates live in `prompts/` (implement-issue, debug-issue, write-test, refactor, review-diff). When starting a task that matches a template, read the template first and follow its structure.

</rules>
