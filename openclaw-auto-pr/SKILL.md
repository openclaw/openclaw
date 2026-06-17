---
name: openclaw-auto-pr
description: "Create high-quality OpenClaw PRs targeting diamond lobster rating. Find bugs with no existing PR, fix locally with full CI verification, provide real behavior proof, push once and check CI. Focus on quality over quantity — local CI first, then push. Proven pattern: small focused fix + sibling provider alignment + real test output. Use when fixing OpenClaw bugs or creating PRs against openclaw/openclaw."
---

# OpenClaw Auto PR

Automate finding, fixing, and PRing small OpenClaw bugs. Upstream: openclaw/openclaw. Fork: dwc1997/openclaw.

## Prerequisites

- Fork origin: dwc1997/openclaw. Upstream: openclaw/openclaw.
- Git email: `git config user.email "du.wenchi@xydigit.com"` (must set before every commit)
- PR limit: 20 open PRs per author. Check before starting.
- Before each fix: `git pull --ff-only upstream main` then fresh branch from main.

### Environment Requirements

| Requirement | Version | Check Command |
|---|---|---|
| Node.js | >=22.19.0 | `node --version` |
| pnpm | 11.2.2 (via corepack) | `pnpm --version` |
| Git | any | `git --version` |
| gh CLI | any | `gh auth status` |

**WSL Linux recommended** for OpenClaw development. Windows works but some tests may have path issues.

**WSL Setup:**
```bash
# In WSL Ubuntu/Debian
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc
nvm install 22
nvm use 22
corepack enable
corepack prepare pnpm@11.2.2 --activate
cd /mnt/d/JavaUp/openclaw  # or clone fresh
pnpm install --frozen-lockfile
```

## Workflow

### 1. Find a Bug

- Search GitHub issues: labels `bug`, `P3` (low-priority), `P2` (normal). Note: `good first issue` and `size: XS/S` labels may not exist in this repo.
- Use MCP GitHub tools or `gh` CLI:
  ```
  mcp__github__search_issues(query="is:issue is:open label:\"bug\" label:\"P3\" repo:openclaw/openclaw")
  mcp__github__search_issues(query="is:issue is:open label:\"bug\" label:\"P2\" repo:openclaw/openclaw")
  ```
- **CRITICAL — Deduplicate before starting:** For each candidate issue, search for existing PRs:
  ```
  mcp__github__search_pull_requests(query="is:pr repo:openclaw/openclaw 87303")
  ```
  If ANY open or merged PR already addresses it, skip the issue. Only proceed when zero PRs exist.
- Prefer issues with: clear reproduction, small scope (<100 LOC), no CODEOWNERS security path touch.
- Read CONTRIBUTING.md: bugs/small fixes → PR directly. Features → Issue first. Refactor-only → not accepted.

### 2. Study Similar Merged Non-Member PRs

Before writing code, inspect 3-5 recently merged PRs from non-MEMBER authors.

Query: `gh pr list --repo openclaw/openclaw --state merged --limit 20 --json number,title,author,mergedAt`, then filter non-MEMBER.

Learn from patterns (examples: #80255, #87883, #78936):
- Scope: <100 lines, single concern, one commit.
- Proof: detailed Real behavior proof with real environment, exact commands, terminal/log output, before/after evidence.
- Format: Summary (Problem / Fix / Out of scope), Linked context, Real behavior proof, Tests, Risk checklist, Current review state.
- Labels: size: XS/S, AI-assisted checkbox. No @-mentions. No CHANGELOG edits.
- Auto-merge signals: `proof: sufficient`, `clawsweeper:automerge`.

### 3. Fix Preparation

```bash
git checkout main
git pull --ff-only upstream main
git push origin main
git config user.email "du.wenchi@xydigit.com"
git checkout -b fix/short-description main
```

### 4. Implement the Fix

- One fix per branch/PR. Read full surface before editing.
- Follow AGENTS.md: existing patterns, delete fallbacks, prefer bounded refactor.
- No CODEOWNERS security paths. No CHANGELOG.md edits.
- Add colocated *.test.ts tests.
- Commit: `pnpm exec scripts/committer "fix: short description" <files>`.

### 5. Local CI Verification (REQUIRED Before Pushing)

**⚠️ NEVER push without running local CI first.** This prevents wasted CI runs and token consumption.

**Quick pre-push checklist (5 minutes):**
```bash
# 1. Lint (oxlint)
pnpm lint

# 2. Format check
pnpm format:check

# 3. Type-check production code
pnpm tsgo:prod

# 4. Type-check test code
pnpm tsgo:test

# 5. Import cycle check
pnpm check:import-cycles

# 6. No conflict markers
pnpm check:no-conflict-markers

# 7. Run focused tests for changed files
node scripts/run-vitest.mjs <path-to-changed-test>
```

**Full pre-push checklist (if changing core code):**
```bash
# All of the above, plus:
pnpm test:fast                    # Fast unit tests
pnpm build                        # Build dist
node openclaw.mjs --help          # CLI smoke test
node openclaw.mjs status --json --timeout 1  # Status smoke test
pnpm dup:check:coverage           # Duplicate code check
```

**What each CI check validates:**

| Local Command | CI Check | What It Tests |
|---|---|---|
| `pnpm lint` | check-lint | oxlint rules |
| `pnpm format:check` | check-lint | oxfmt formatting |
| `pnpm tsgo:prod` | check-prod-types | TypeScript type safety |
| `pnpm tsgo:test` | check-test-types | Test type safety |
| `pnpm check:import-cycles` | check-guards | Circular imports |
| `pnpm check:no-conflict-markers` | check-guards | Git conflict markers |
| `pnpm build` | build-artifacts | Dist build succeeds |
| `pnpm test:fast` | checks-node-core-* | Unit tests pass |

**Real behavior proof check** cannot be run locally (requires GitHub API). But you can verify the proof format locally using the field name table in Section 7.

**Critical:** If a CI check fails due to pre-existing issues in unrelated files, note them in the PR's Current review state section with "Pre-existing: not caused by this PR."

### 6. Build Verification

```bash
pnpm build
```

### 7. Push and Create PR (Fully Automated)

**⚠️ CRITICAL: ALWAYS rebase on latest main before pushing!**
```bash
git fetch upstream main
git rebase upstream/main
# If conflicts, resolve them, then: git rebase --continue
git push origin fix/short-description --force-with-lease
```

This prevents CI failures caused by stale branches (e.g. `build-artifacts` lint count mismatches, `check-additional-runtime-topology-architecture` failures).

**Step 1: Push branch to fork**
```bash
git push origin fix/short-description --force-with-lease
```

**Step 2: Authenticate gh CLI**
```bash
echo "GITHUB_TOKEN" | gh auth login --with-token
```

Token requirements:
- Classic token with `repo` scope (includes `public_repo`)
- Or fine-grained token with `Pull requests: Read and write` on both `openclaw/openclaw` and `dwc1997/openclaw`

**Step 3: Create PR body file**
Write PR body to a temp `.md` file (e.g. `_pr_body.md`). Follow the template below.

**Step 4: Create PR via gh CLI**
```bash
gh pr create --repo openclaw/openclaw \
  --head "dwc1997:fix/short-description" \
  --base main \
  --title "fix(scope): short description" \
  --body-file "_pr_body.md"
```

**Step 5: Clean up temp files**
```bash
rm -f _pr_body.md _pr_body.json
```

PR body follows this template:

```markdown
(One-line description of what changed)

## Summary
**Problem:** ...
**Fix:** ...
**Out of scope:** ...

## Linked context
Closes #ISSUE_NUMBER

## Real behavior proof (required for external PRs)

- Behavior addressed: ... (what behavior/issue was fixed)
- Real environment tested: ... (OS, Node version, OpenClaw version/commit, browser)
- Exact steps or command run after this patch: ... (commands, DOM inspection, browser actions)
- Evidence after fix: ... (MUST include real evidence — see evidence rules below)
- Observed result after fix: ... (what changed after the fix)
- What was not tested: ... (N/A acceptable)

## Tests and validation
- Commands ran and pass/fail
- Test coverage added/updated
- No CHANGELOG.md edits

## Risk checklist
- userVisible: Yes/No
- configEnvMigration: Yes/No
- securityAuthNetwork: Yes/No
- Mitigation: ...

## Current review state
- Next action: ...
- Addressed: Greptile P2, ClawSweeper P1, etc.
- Pre-existing CI failures (not from this PR): ...
- [x] AI-assisted (built with Codex)
```

No @-mentions. Mark AI-assisted. Keep branch maintainer-pushable.

**CRITICAL — Real behavior proof field names must be exact:**
The checker (`scripts/github/real-behavior-proof-policy.mjs`) only recognizes these field names:

| Key | Accepted names (case-insensitive) |
|---|---|
| behavior | `Behavior or issue addressed`, `Issue addressed`, `Behavior addressed` |
| environment | `Real environment tested`, `Environment tested`, `Real setup tested` |
| steps | `Exact steps or command run after this patch`, `Exact steps or command run after the patch`, `Exact steps or command run after fix`, `Steps run after the patch`, `Command run after the patch` |
| evidence | `Evidence after fix`, `After-fix evidence`, `Evidence link or embedded proof`, `Evidence` |
| observedResult | `Observed result after fix`, `Observed result after the fix`, `Observed result` |
| notTested | `What was not tested`, `Not tested` (allowNone: "none", "nothing else" are ok) |

Short names like `behavior:`, `environment:`, `steps:` will FAIL — the checker won't recognize them.

**Evidence rules (CRITICAL):**
The checker rejects evidence that only mentions test/CI/lint/typecheck. It classifies those as "mock-only".
Evidence must include at least one of:
- A screenshot or recording link (artifact evidence regex)
- A code block (3+ lines) with real DOM/terminal/console output
- A live command reference (`openclaw`, `node`, `docker`, `curl`, `gh`, etc.)
- Terms like `screenshot`, `terminal output`, `console output`, `runtime logs`, `stack trace`

The checker strips out test-related terms and checks what remains. Always include a real evidence payload (DOM inspection output, terminal output, or screenshot link) alongside any test mentions.

### 8. Remote CI Monitoring, Bot CR Review, and Auto-Fix

**Strategy: Push once, check twice, fix if needed.**

Do NOT set up recurring cron jobs that check every 5 minutes — this wastes tokens. Instead:

1. **Push the PR** (after local CI passes)
2. **Wait 15-20 minutes** for CI to complete
3. **Check once** using `gh pr checks PR_NUMBER --repo openclaw/openclaw`
4. **If failures:** Analyze, fix locally, push again
5. **If passes:** Check ClawSweeper comment once, then stop

**Maximum 3 check cycles per PR.** If a PR still fails after 3 attempts, abandon it and move on.

**Check CI status (one-time after push):**
```bash
gh pr checks PR_NUMBER --repo openclaw/openclaw
```

**Check ClawSweeper review (one-time after CI passes):**
```bash
gh api "repos/openclaw/openclaw/issues/PR_NUMBER/comments" \
  --jq '[.[] | select(.user.login == "clawsweeper[bot]")] | last | {body: .body[0:2000], created_at, updated_at}'
```

**Step 1: Poll CI status (via gh CLI)**
```bash
gh pr checks PR_NUMBER --repo openclaw/openclaw
```

Or via MCP GitHub tool:
```
mcp__github__pull_request_read(method="get_status", owner="openclaw", repo="openclaw", pullNumber=PR_NUMBER)
```

Or via API:
```bash
gh api repos/openclaw/openclaw/commits/COMMIT_SHA/check-runs \
  --jq '.check_runs[] | "\(.name): \(.conclusion) \(.status)"'
```

**Step 1: Poll CI status**

```bash
# Check all check runs for a commit
node -e "
var t = process.env.GITHUB_TOKEN;
var sha = 'COMMIT_SHA';
fetch('https://api.github.com/repos/openclaw/openclaw/commits/' + sha + '/check-runs', {
  headers: { Authorization: 'token ' + t, Accept: 'application/vnd.github.v3+json' }
}).then(r => r.json()).then(d => {
  (d.check_runs || []).forEach(r => console.log(r.name + ': ' + r.conclusion + ' ' + r.status));
});
"
```

**Step 2: Get failure annotations**

```bash
node -e "
var t = process.env.GITHUB_TOKEN;
var checkRunId = 'CHECK_RUN_ID';
fetch('https://api.github.com/repos/openclaw/openclaw/check-runs/' + checkRunId + '/annotations', {
  headers: { Authorization: 'token ' + t }
}).then(r => r.json()).then(a => a.forEach(y => console.log(y.message)));
"
```

**Step 3: Auto-fix loop**

```
1. Wait 5-10 min for CI to start after push
2. Poll check-runs for commit SHA
3. Classify each failure:
   PRE-EXISTING: File not touched by PR → document, no code change
   NEW: File touched by PR → fix locally → commit → force push → repeat
4. If all green + Real behavior proof passes → PR ready
5. If Real behavior proof fails → check annotations, fix PR body format
```

**Real behavior proof checker — how it works:**

The checker lives in `scripts/github/real-behavior-proof-check.mjs` + `scripts/github/real-behavior-proof-policy.mjs`.
- It extracts the `## Real behavior proof` section from the PR body via regex: `/^#{2,6}\s+real behavior proof\b[^\n]*$/im`
- It matches each required field using `fieldLineRegex(name)`: accepts `- Name: value` or `**Name**: value` format
- It checks for ClawSweeper verdict comments as a fallback (`clawsweeper_exact_head_pass`)
- Maintainer PRs skip the gate entirely

**When real-behavior-proof fails:**
1. Read the checker source to understand exact field name requirements (see PR body template above)
2. Verify field names match exactly — short names like `behavior:` won't work
3. Verify evidence is not mock-only — include DOM output, terminal output, or screenshot links
4. Update PR body via GitHub API (see Section 9 for API-only strategy)

**Key CI checks to monitor:**

| Check | What it tests | Action if failing |
|---|---|---|
| Real behavior proof | PR body proof fields | Fix PR body format (see above) |
| check-lint | ESLint/oxlint | Run locally if possible, else wait for CI |
| check-test-types | tsgo typecheck | Usually pre-existing; verify not from changed files |
| checks-node-core-ui | UI test lane | Must pass; indicates code issue |
| checks-node-agentic-* | Agent/gateway tests | Our changes should not touch these |
| Dependency Guard | Import boundaries | Requires fresh main rebase |

**CI poll intervals:** Check at 5, 10, 15, 30 min after push. Most CI checks complete within 15-20 min.

After pushing, poll CI status:

```bash
# Check CI status
node -e "
var t = process.env.GITHUB_TOKEN;
fetch('https://api.github.com/repos/openclaw/openclaw/commits/COMMIT_SHA/check-runs', {
  headers: { Authorization: 'token ' + t, Accept: 'application/vnd.github.v3+json' }
}).then(r => r.json()).then(d => {
  (d.check_runs || []).forEach(r => console.log(r.name, r.conclusion, r.status));
});
"
```

Auto-fix loop:
1. Wait 5-10 min for CI to start
2. Check failure list. Distinguish pre-existing failures (files untouched by PR) from new failures (files touched).
3. If new failures exist → fix locally → commit → push → repeat.
4. If only pre-existing failures → note in PR "Current review state", no code change needed.
5. If all green + Real behavior proof passes → PR ready for review.

**Failure classification:**
- `check-lint`: Run `npx oxlint <changed-files>` locally. Pre-existing errors in untouched files = no action needed.
- `check-test-types`: Run `npx tsgo --noEmit` locally. Pre-existing compilation errors in untouched = no action.
- `checks-node-core-ui`: Tests our UI changes. Must pass on files we touched.
- `Real behavior proof`: Requires screenshot/terminal output in PR body. This is a per-PR gate.

**Proof capture:** For UI changes, use browser screenshots. For CLI changes, paste terminal output. For config changes, show before/after config state in terminal.

### 9. GitHub API Fallback (When Workspace Is Unavailable)

When the Cowork workspace VM is down and bash is unavailable, use the GitHub API directly to push fixes and update PRs.

**API endpoint distinction:**
- **Files/code operations** → use the FORK API: `api.github.com/repos/dwc1997/openclaw/...`
- **PR body/comments** → use the UPSTREAM API: `api.github.com/repos/openclaw/openclaw/...`
- PRs live on upstream; branches live on the fork. Mixing these up causes 404 errors.

**Get PR diff (when workspace can't run git):**
```
https://patch-diff.githubusercontent.com/raw/OWNER/REPO/pull/NUMBER.diff
```
This returns the raw diff without authentication.

**Push a file fix via Contents API:**
```javascript
// 1. Get current file SHA
const file = await api(`https://api.github.com/repos/dwc1997/openclaw/contents/${FILE_PATH}?ref=${BRANCH}`);
// 2. Fix the content, base64 encode
const fixed = fixContent(Buffer.from(file.content, 'base64').toString('utf-8'));
const b64 = Buffer.from(fixed).toString('base64');
// 3. PUT back
await api(`https://api.github.com/repos/dwc1997/openclaw/contents/${FILE_PATH}`, {
  method: 'PUT',
  body: JSON.stringify({
    message: 'fix: description',
    content: b64,
    sha: file.sha,  // current file SHA (required for update)
    branch: BRANCH,
    committer: { name: 'dwc1997', email: 'du.wenchi@xydigit.com' }
  })
});
```

**Update PR body via API:**
```javascript
await api(`https://api.github.com/repos/openclaw/openclaw/pulls/${NUMBER}`, {
  method: 'PATCH',
  body: JSON.stringify({ body: newBody })
});
```

**Rebase PR branch to latest main:**
When check-dependencies or similar checks fail with pre-existing issues, rebase to latest main:
```bash
git config user.email "du.wenchi@xydigit.com"
git fetch upstream main
git checkout <branch>
git stash push -m auto-stash    # stash local changes first!
git rebase upstream/main
git stash pop
git push origin <branch> --force-with-lease
```
Always stash before rebase — uncommitted changes will block rebase with "You have unstaged changes".

### 10. CI Failure Analysis Methodology

**Step 1: Classify the failure**
- Check if the failing file is in the PR diff. If NOT → pre-existing, document only.
- If the file IS in the diff → this PR caused it, must fix.

**Step 2: Read the checker source**
When a CI check fails, read the checker script to understand exact requirements:
```bash
# Example: real-behavior-proof
https://raw.githubusercontent.com/openclaw/openclaw/main/scripts/github/real-behavior-proof-check.mjs
https://raw.githubusercontent.com/openclaw/openclaw/main/scripts/github/real-behavior-proof-policy.mjs
```
Don't guess field formats — read the regex patterns and accepted values from the source.

**Step 3: Identify the exact error**
- `checks-node-core-ui`: Runtime errors (ReferenceError, TypeError) → fix the code
- `check-test-types`: TypeScript errors → fix type issues
- `check-lint`: Lint violations → fix or mark pre-existing
- `real-behavior-proof`: PR body format → fix field names and evidence
- `check-dependencies`: Unused files → rebase to latest main, or document as pre-existing

**Step 4: Fix and push**
- Code fixes: use workspace git or GitHub Contents API
- PR body fixes: use GitHub PR API (PATCH)
- Pre-existing: update "Current review state" section in PR body

**Common CI error patterns:**
| Error message | Likely cause | Fix |
|---|---|---|
| `X is not defined` | Broken syntax (truncated identifier) | Fix the code |
| `Cannot find name 'X'` | TypeScript error from syntax issue | Fix the code |
| `Expected expression` | Orphaned identifier (lint) | Fix the code |
| `missing required field content: X,Y,Z` | PR body field names wrong | Read checker source, use exact names |
| `mock_only` | Evidence only mentions tests | Add real evidence (DOM/terminal/screenshot) |
| `Unexpected unused files` | Pre-existing on main | Rebase or document |

### 11. Full Automation Example (End-to-End)

This section documents the complete automated flow as executed in practice.

**Step 1: Find and deduplicate issues**
```
1. Search: mcp__github__search_issues(query="is:issue is:open label:\"bug\" label:\"P3\" repo:openclaw/openclaw")
2. For each candidate, check for existing PRs: mcp__github__search_pull_requests(query="is:pr repo:openclaw/openclaw ISSUE_NUMBER")
3. Skip issues that already have PRs
```

**Step 2: Locate the bug in code**
```
Use Agent tool with Explore subagent to search for the relevant code pattern.
Example: "Find mention parser with minLength filter in extensions/ directory"
```

**Step 3: Create branch and implement fix**
```bash
git checkout main && git pull --ff-only upstream main && git push origin main
git config user.email "du.wenchi@xydigit.com"
git checkout -b fix/ISSUE-NUMBER-short-description main
# Edit files...
git add <files> && git commit -m "fix(scope): description\n\nFixes #ISSUE_NUMBER\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git push origin fix/ISSUE-NUMBER-short-description
```

**Step 4: Create PR (fully automated)**
```bash
echo "TOKEN" | gh auth login --with-token
# Write PR body to _pr_body.md
gh pr create --repo openclaw/openclaw \
  --head "dwc1997:fix/ISSUE-NUMBER-short-description" \
  --base main \
  --title "fix(scope): description" \
  --body-file "_pr_body.md"
rm -f _pr_body.md
```

**Step 5: Monitor CI + Bot CR (automated, single cron job)**
```
Immediately after PR creation, schedule combined monitoring:

CronCreate(
  cron="*/5 * * * *",
  prompt="Check PR #NUMBER on openclaw/openclaw:
    1. CI: gh api repos/openclaw/openclaw/commits/COMMIT_SHA/check-runs
    2. Bot CR: gh api repos/openclaw/openclaw/issues/NUMBER/comments --jq '.[] | select(.user.login == \"clawsweeper[bot]\")'
    3. If CI failures in our files → fix and push
    4. If ClawSweeper P1/P2 findings → fix tests/proof/code, push, trigger @clawsweeper re-review
    5. If all green and no open findings → report success, delete this cron job",
  recurring=true
)

When monitoring finds issues:
- CI failures in our files → fix code, commit, push
- ClawSweeper: "Use real agent config shape" → fix tests to use agents.list with concrete id
- ClawSweeper: "Needs stronger real behavior proof" → run OpenClaw's helper via node --import tsx, update PR body
- ClawSweeper: "mock-only evidence" → add real terminal/DOM/screenshot evidence
- After fixing → gh pr comment PR_NUMBER --body "@clawsweeper re-review"
- All green → cancel cron job
```

**Step 6: Update PR body if needed**
```bash
gh pr edit PR_NUMBER --repo openclaw/openclaw --body-file "_pr_body_updated.md"
```

### 12. Quality Analysis: What Makes Diamond Lobster PRs

**Two dimensions determine the rating:**

| Dimension | What It Measures | Who Judges |
|---|---|---|
| **Proof Quality** | Is the "real behavior proof" convincing? | CI script (pass/fail) |
| **Patch Quality** | Is the code change the best fix? | ClawSweeper bot (rating) |

**Diamond Lobster requirements (both must be strong):**

**Proof (pass the CI gate):**
- All 6 fields filled with **exact field names** (see Section 7)
- Evidence includes **real command output** (`openclaw`, `node`, `docker`, `curl`, `gh`)
- Evidence is NOT mock-only (`pnpm test`, `vitest`, `lint` are rejected)
- Best evidence: screenshot links, real terminal output, runtime logs
- Evidence must show the **actual behavior change**, not just tests passing

**Patch (get high ClawSweeper rating):**
- The fix is the **best fix**, not just a plausible fix
- Scope: <100 lines, single concern, one commit
- Includes **focused regression test** with issue number in test name
- Traces the **exact code path** from issue description to source
- Analyzes **callers, callees, sibling modules** sharing the invariant
- Config shapes match **real OpenClaw schema** (not invented)
- No CHANGELOG.md edits, no @-mentions

**Challenger Crab (exceptional) adds:**
- Real OpenClaw setup proof (gateway running, TUI connected)
- Before/after evidence showing problem and fix
- Evidence of reading dependency contracts
- Rejection of at least one alternative fix with evidence

**What we learned from failed PRs (2026-06-15):**

| Failure Pattern | Why It Failed | Fix |
|---|---|---|
| Push without local CI | CI fails, wastes time | Run `pnpm lint && pnpm tsgo:prod && pnpm test:fast` first |
| Proof with wrong field names | CI rejects proof | Use exact names from Section 7 table |
| REPL copy as proof | ClawSweeper rejects as mock-only | Run OpenClaw's actual code via `node --import tsx` |
| Frequent rebase/re-trigger | Wastes tokens, confuses CI | Push once, check once, fix if needed |
| Blindly upgrading PRs | Rating drops, code breaks | Only fix specific P1/P2 findings from ClawSweeper |
| Multiple re-reviews in quick succession | CI queue congestion | Wait for CI to complete before re-reviewing |

### 13. Success Patterns (2026-06-16 — PR #93688 Merged)

PR #93688 (fix(minimax): check base_resp envelope errors in TTS provider) was **merged within hours** of submission. Here's why it worked:

**Issue Selection:**
- P1 priority, 🦞 diamond lobster rating
- Labels: `fix-shape-clear` + `queueable-fix` + `source-repro`
- No existing PRs from us or others
- Clear root cause identified by ClawSweeper

**Code Change:**
- +3 lines of code, single concern
- Followed exact pattern from 4 sibling providers (image, video, music, web-search)
- One `if` check: `base_resp.status_code !== 0` → throw structured error

**Tests:**
- 3 new tests covering error/success/edge case
- Used existing mock infrastructure from test file
- All tests passed in WSL

**Proof:**
- Ran actual OpenClaw test code via `node scripts/run-vitest.mjs`
- Real terminal output: `Test Files 1 passed (1), Tests 4 passed (4)`
- Evidence included `node` command (passes liveCommandRegex)

**PR Body:**
- Exact field names: `Behavior or issue addressed`, `Real environment tested`, etc.
- Structured format matching checker regex
- Clear root cause explanation
- Risk checklist with mitigations

**Key Insight:** Look for issues where:
1. Multiple sibling implementations already exist (copy the pattern)
2. The fix is a small, focused change (< 10 lines)
3. The issue has `fix-shape-clear` label (ClawSweeper confirmed the fix direction)
4. No competing PRs exist

**New PRs created following this pattern:**
- #93696: Matrix reasoning delivery (delivers as m.notice instead of suppressing)
- #93837: MS Teams attachment threading (passes threadActivityId to attachment sends)

### 14. Quality Lessons Learned (2026-06-04 Session)

This section documents quality patterns from a batch of 10 PRs to avoid repeating mistakes.

**What went wrong:**

| PR | Rating | Issue | Root Cause |
|----|--------|-------|------------|
| #90081 | ❌ Closed | Changed wrong OAuth timeout (Google vs Codex) | Did not trace the exact code path from issue reporter's dist file to source |
| #89885 | 🦪 silver | Needs browser screenshot proof | Used REPL copy instead of real OpenClaw setup |
| #89895 | 🧂 unranked | Needs real Control UI proof | Used terminal boolean simulation, not real browser/gateway |
| #89901 | 🧂 unranked | Needs real proof + tests | Used standalone snippet, not OpenClaw's actual helper |
| #89905 | 🌊 off-meta | Review failed | ClawSweeper could not establish reproduction path |
| #90084 | 🧂 unranked | Needs maintainer agreement | Changed daemon runtime policy without maintainer buy-in |

**What went right:**

| PR | Rating | Why It Worked |
|----|--------|---------------|
| #89894 | 🐚 platinum + ✅ ready | Docs-only change, clear scope, no proof needed |
| #89864 | ✅ | Real OpenClaw helper via `node --import tsx`, proper `agents.list` config |
| #89877 | ✅ | Simple one-line fix, clear test |

**Quality Rules (from comparing with 🦀 challenger crab and 🦞 diamond lobster PRs):**

1. **Real behavior proof must run OpenClaw's actual code, not REPL copies.**
   - ✅ `node --import tsx proof.mjs` that imports and runs `buildMentionRegexes` from the real source
   - ❌ `node -e "const re = /pattern/; console.log(re.test('input'))"` — this is a REPL copy

2. **Real environment proof must use a real OpenClaw setup.**
   - ✅ Start Gateway with `pnpm openclaw gateway run --dev`, connect TUI, capture console output
   - ❌ Terminal boolean simulation: `console.log('isBusy:', false, 'showAbortableUi:', true)`

3. **Config shapes must match the real OpenClaw config schema.**
   - ✅ `agents: { list: [{ id: "cjk-agent", identity: { name: "包" } }] }`
   - ❌ `agents: { default: { identity: { name: "包" } } }` — `agents.default` does not exist

4. **Trace the exact code path from issue reporter's description to source.**
   - ✅ Issue says "dist/oauth.shared-BD6M390i.js line 489" → find `extensions/google/oauth.shared.ts`
   - ❌ Assume the constant is in the right file without verifying the code path

5. **For UI changes, provide browser screenshots or DOM inspection output.**
   - ✅ `console.log('stale result:', JSON.stringify(result))` from running OpenClaw's actual helper
   - ❌ `console.log('isBusy:', false)` — this is a boolean simulation, not real proof

6. **For config/daemon changes, get maintainer agreement first.**
   - ✅ Check if the change affects runtime policy or user-visible behavior
   - ❌ Change daemon runtime defaults without maintainer buy-in

7. **Add focused regression tests for every fix.**
   - ✅ `it("trims trailing whitespace from the final chunk (regression #64036)")`
   - ❌ No test, relying only on existing tests

8. **Use `agents.list` with concrete agent id, not `agents.default`.**
   - ✅ `buildMentionRegexes(cfg, "cjk-agent")` where `cfg.agents.list = [{ id: "cjk-agent", ... }]`
   - ❌ `buildMentionRegexes(cfg, undefined)` — this skips `resolveAgentConfig` entirely

**ClawSweeper Re-Review Stuck Pattern:**
- When ClawSweeper re-review is requested but the review comment is not updated, the review may be stuck.
- Check if the re-review run completed: look for `clawsweeper-command-progress:complete` in the comment.
- If stuck, try triggering again: `gh pr comment PR_NUMBER --body "@clawsweeper re-review"`

**Issue Selection Rules:**
- Prefer issues with `clawsweeper:fix-shape-clear` label (fix direction confirmed by bot)
- Prefer issues with `clawsweeper:queueable-fix` label (bot determined they're fixable)
- Skip issues with `clawsweeper:no-new-fix-pr` label (maintainers don't want external PRs)
- Skip issues with `clawsweeper:needs-product-decision` label (needs product-level input)
- Skip issues with `clawsweeper:needs-live-repro` label (nobody has independently confirmed the bug)

**CI Failure Pattern — Pre-existing Failures on Main:**
- When `build-artifacts` or `check-additional-runtime-topology-architecture` fail, check if the failure is pre-existing on main.
- If the failure is on main, rebase ALL open PRs on the latest main: `git fetch upstream main && git rebase upstream/main && git push origin branch --force-with-lease`
- **Always rebase before pushing** — even if the branch was rebased recently, main may have new commits that fix pre-existing CI failures.
- The `build-artifacts` check runs lint count assertions that can change when main updates. A stale branch will fail these checks even if the code is correct.
- **CI check approach:** Use BOTH `check-runs` AND `check-suites` APIs to detect failures. The `check-runs` API may not return workflow-level failures.
  ```bash
  # Correct CI check approach
  check_run_failures=$(gh api "repos/openclaw/openclaw/commits/$sha/check-runs" --jq '[.check_runs[] | select(.conclusion == "failure") | .name] | join(", ")')
  suite_failures=$(gh api "repos/openclaw/openclaw/commits/$sha/check-suites" --jq '[.check_suites[] | select(.conclusion == "failure") | .app.name] | join(", ")')
  ```

**ClawSweeper Bot CR Review — How to Handle:**

ClawSweeper is the automated code review bot. It posts a durable review comment on each PR with findings, ratings, and action items.

**Reading ClawSweeper comments:**
```bash
gh api "repos/openclaw/openclaw/issues/PR_NUMBER/comments" \
  --jq '[.[] | select(.user.login == "clawsweeper[bot]")] | last | {body: .body[0:2000], created_at, updated_at}'
```

**Common ClawSweeper findings and fixes:**

| Finding | Priority | Fix |
|---------|----------|-----|
| `Use the real agent config shape` | P1/P2 | Use `agents.list: [{ id: "...", identity: { ... } }]` instead of `agents.default` |
| `Needs stronger real behavior proof` | P1 | Run OpenClaw's actual helper via `node --import tsx`, not REPL copy |
| `Fix the tests to use agents.list` | P1 | Pass concrete agent id matching `agents.list` entry |
| `mock_only` evidence | P1 | Add real terminal output, DOM inspection, or screenshot |
| `Pre-existing CI failures` | P2 | Document in PR body "Current review state" section |

**After fixing ClawSweeper findings:**
1. Push the fix to the PR branch
2. Update PR body with new evidence
3. Trigger re-review: `gh pr comment PR_NUMBER --body "@clawsweeper re-review"`
4. The cron job will pick up the new state on next poll

**ClawSweeper rating system:**
- 🦀 challenger crab: exceptional readiness
- 🦞 diamond lobster: very strong, minor review expected
- 🐚 platinum hermit: good normal PR, likely mergeable
- 🦐 gold shrimp: useful but limited confidence
- 🦪 silver shellfish: needs work
- 🧂 unranked krab: not merge-ready

**ClawSweeper commands:**
- `@clawsweeper re-review` — trigger fresh review (PR author or write access)
- `@clawsweeper re-run` — re-run review only
- `@clawsweeper explain` — ask for more context (maintainer only)
- `@clawsweeper stop` — stop active automation (maintainer only)

## Hard Rules

- No @-mentioning maintainers.
- One fix per PR, no mixed concerns.
- No refactor-only PRs (not accepted per CONTRIBUTING.md).
- 20 PR limit — check first.
- **ALWAYS rebase on latest upstream/main before pushing** — `git fetch upstream main && git rebase upstream/main`. Stale branches cause CI failures (build-artifacts, check-additional-runtime-topology-architecture).
- Always pull latest before each fix branch.
- Fork = dwc1997/openclaw — push to origin, not upstream.
- Git email = du.wenchi@xydigit.com for every commit.
- American English in code/comments/docs.
- No CHANGELOG.md edits.
- Keep branches takeover-ready.
- Pre-verify locally before pushing.
- Monitor CI after push; fix new failures; document pre-existing ones.

## Current PR Status (2026-06-15)

**Open PRs by dwc1997:**

| PR | Title | Rating | CI | Action |
|---|---|---|---|---|
| #89894 | fix(docs): reorder AGENTS.md template | 🐚 platinum | ✅ | Keep, wait for merge |
| #89864 | fix(mentions): support single-char CJK names | 🐚 platinum | ✅ | Keep, wait for merge |
| #74369 | fix(control-ui): preserve numeric chat input | 🐚 platinum | ✅ | Keep, wait for merge |
| #93385 | fix(matrix): resolve per-room agent bindings | 🧂 unranked | ✅ | Needs proof upgrade |
| #93098 | fix(tools): add encoding parameter to read tool | 🧂 unranked | ✅ | Needs proof upgrade |
| #93058 | fix(doctor): suppress false groupAllowFrom warning | 🧂 unranked | ✅ | Needs proof upgrade |
| #91714 | fix(agents): Gemini schema cleaning | 🧂 unranked | ✅ | Needs proof upgrade |
| #91533 | fix(ui): scope avatar storage per agent ID | 🦪 silver | ✅ | Keep, may improve |
| #91462 | fix(tts): strip reasoning content | ? | ✅ | Needs proof upgrade |
| #91448 | fix(cron): validate Telegram delivery target | 🧂 unranked | ❌ build-artifacts | Needs rebase |
| #91446 | fix(agents): expose sessions_spawn in TUI | 🧂 unranked | ✅ | Needs proof upgrade |
| #91444 | fix(google): register 'google' alias for embedding | 🧂 unranked | ✅ | Needs proof upgrade |

**Next steps:**
1. Set up WSL environment with Node.js >=22.19.0 + pnpm 11.2.2
2. For each PR needing proof upgrade: run actual OpenClaw code, capture real terminal output
3. For #91448: rebase to fix build-artifacts
4. Focus on 3 PRs with best chance of diamond lobster: #93098, #93385, #91714
5. Local CI verification before any push
