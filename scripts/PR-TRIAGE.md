# AI PR Triage System

AI-powered duplicate detection and categorization for pull requests. Single Claude call per PR with cached context of all open PRs and recent merge/close decisions.

## Architecture

**3 files, zero dependencies beyond Node.js stdlib + `fetch`:**

| File                              | Lines | Purpose                              |
| --------------------------------- | ----- | ------------------------------------ |
| `.github/workflows/pr-triage.yml` | 45    | GitHub Action workflow               |
| `scripts/pr-triage.mjs`           | 268   | Main orchestrator + LLM call         |
| `scripts/pr-triage-github.mjs`    | 290   | GitHub API client + shared utilities |
| `scripts/pr-triage-labels.mjs`    | 114   | Label application + summary output   |

## How It Works

```
PR opened/reopened
    |
    v
Fetch target PR (title, body, diff, files)
    |
    v
Fetch all open PRs (up to 500) with file lists
    |
    v
Fetch recent merge/close decisions (up to 100)
    |
    v
Compute deterministic signals (Jaccard file overlap)
    |
    v
Single Claude API call:
  - System prompt (cached): open PR summaries + decisions + CONTRIBUTING.md
  - User message (fresh): new PR details + deterministic hints
  - Output: structured JSON via json_schema
    |
    v
Validate output (filter hallucinated PR refs, validate enums)
    |
    v
Apply silent labels (no public bot comments)
    |
    v
Write GitHub Action summary (private)
```

## Single LLM Call Design

One API call per PR with two cached system blocks:

1. **Stable instructions** (~2K tokens, high cache hit rate): task description, rules, project focus from CONTRIBUTING.md
2. **Dynamic context** (~20-50K tokens, 5-min cache window): all open PR summaries + merged/rejected decisions

The user message (~2K tokens) contains only the new PR's details.

### Model Configuration

- **Default**: Claude Opus 4.6 with adaptive thinking (`thinking: { type: "adaptive" }`)
- **Structured output**: `output_config.format` with `json_schema` type
- **Effort**: configurable via `TRIAGE_EFFORT` env var (default: `high`)
- **Override model**: `TRIAGE_MODEL` env var

### Cost

With prompt caching, the ~20-50K token system prompt is cached across PRs opened within the same 5-minute window. Typical cost per call:

| Model      | First call  | Cached calls |
| ---------- | ----------- | ------------ |
| Opus 4.6   | ~$0.15-0.30 | ~$0.03-0.06  |
| Sonnet 4.5 | ~$0.09-0.18 | ~$0.02-0.04  |
| Haiku 4.5  | ~$0.03-0.06 | ~$0.006-0.01 |

## Duplicate Detection

Three-layer approach:

1. **Deterministic pre-enrichment**: Jaccard similarity on file paths between the new PR and all open PRs. Overlaps > 0.3 are passed as hints to the LLM.
2. **Issue reference extraction**: Contextual regex matching for `fixes #N`, `closes #N`, bare `#N` references.
3. **Semantic analysis**: The LLM reads all PR summaries and identifies duplicates, subsets, supersets, and related work.

## Output Schema

```json
{
  "duplicate_of": [1234], // PR numbers this duplicates
  "related_to": [5678], // PRs with overlapping work
  "category": "bug", // bug|feature|refactor|test|docs|chore
  "confidence": "high", // high|medium|low
  "quality_signals": {
    "focused_scope": true,
    "has_tests": false,
    "appropriate_size": true,
    "references_issue": true
  },
  "suggested_action": "needs-review", // needs-review|likely-duplicate|needs-discussion|auto-label-only
  "reasoning": "Brief explanation"
}
```

All PR number references are validated against known open PRs — hallucinated numbers are filtered out.

## Labels Applied

| Condition                           | Label                        | Color  |
| ----------------------------------- | ---------------------------- | ------ |
| Always                              | `auto:{category}`            | purple |
| High confidence + duplicates found  | `possible-overlap`           | yellow |
| High confidence + duplicates found  | `cluster:#{N}` per duplicate | yellow |
| Suggested action = likely-duplicate | `triage:likely-duplicate`    | yellow |
| Suggested action = needs-discussion | `triage:needs-discussion`    | green  |
| No issue references                 | `triage:no-issue-ref`        | green  |
| No tests (non-docs)                 | `triage:no-tests`            | green  |

Labels are created automatically if they don't exist.

## UX Design: Invisible to Contributors

- **No public bot comments** — only silent labels
- Reasoning is written to the GitHub Action summary (visible only to maintainers)
- This avoids the "matplotlib/crabby-rathbun incident" risk where public AI comments on PRs caused community backlash

## Implicit Preference Learning

The system fetches recent merged and closed-without-merge PRs and includes them in the system prompt. The model learns maintainer preferences from these examples:

- What gets merged vs rejected
- Patterns in PR titles, sizes, scope
- Quality expectations

No explicit rubric or VISION.yaml — the model adapts from the data.

## Prompt Injection Defense

PR content (title, body, diff) is untrusted user input. Defenses:

1. **`sanitizeUntrusted()`**: Strips XML-like tags (`<system>`, `<instructions>`, `<override>`, etc.) and replaces triple backticks
2. **Length limits**: Body capped at 4K chars, diff at 8K chars
3. **System prompt warning**: Explicit instruction that PR content is untrusted
4. **Structured output**: JSON schema enforcement prevents free-form text injection into output

## Configuration

All configurable via environment variables:

| Variable         | Default           | Description                                              |
| ---------------- | ----------------- | -------------------------------------------------------- |
| `TRIAGE_MODEL`   | `claude-opus-4-6` | Anthropic model to use                                   |
| `TRIAGE_EFFORT`  | `high`            | Adaptive thinking effort level                           |
| `MAX_OPEN_PRS`   | `500`             | Max open PRs to fetch for context                        |
| `MAX_HISTORY`    | `100`             | Max merged/closed PRs for preference learning            |
| `MAX_DIFF_CHARS` | `8000`            | Max diff characters to include                           |
| `DRY_RUN`        | `0`               | Set to `1` to skip LLM call (deterministic signals only) |

## GitHub Action Setup

### Required Secrets

- `ANTHROPIC_API_KEY` — Anthropic API key
- `GH_APP_PRIVATE_KEY` — GitHub App private key (app-id: 2729701)

### Workflow Triggers

- `pull_request_target: [opened, reopened]` — auto-triages new/reopened PRs
- `workflow_dispatch` with `pr_number` input — manual triage of specific PR

### Permissions

```yaml
permissions:
  contents: read
  pull-requests: write
  issues: read
```

## Rate Limit Budget System

### The Problem

With 500 open PRs, the original REST-only approach made **~512 API calls per triage run** (1 call per PR for file lists). GitHub allows 5000/hour, so only ~9 triage runs per hour were possible before hitting the limit. A burst of 10 PRs would exhaust the budget.

### The Solution: GraphQL Batch Fetching

File lists are now fetched via GraphQL in batches of 50 PRs per query:

| Approach      | API calls for 500 PRs | Runs/hour capacity |
| ------------- | --------------------- | ------------------ |
| REST (old)    | ~512 REST             | ~9                 |
| GraphQL (new) | ~22 REST + 10 GraphQL | ~227               |

**25x improvement** in API efficiency.

### Graceful Degradation

1. **Budget check** at startup — `checkRateBudget()` reads `/rate_limit` endpoint
2. If remaining < 100, **skips file fetching entirely** — falls back to semantic-only triage (no Jaccard overlap, but LLM still detects duplicates from PR titles/descriptions)
3. Rate limit errors (HTTP 429 or 403 with `x-ratelimit-remaining: 0`) trigger automatic backoff using the `x-ratelimit-reset` header
4. 3 retries per request with exponential backoff (capped at 60s)

### API Budget Per Run (verified)

```
REST API:  ~7 calls (rate check + target PR + pagination + labels)
GraphQL:   ~1 call per 50 PRs (batch file fetch)
Total:     ~12 calls for 50 PRs, ~22 for 500 PRs
```

## Verified Test Results

Tested against real openclaw/openclaw PRs with Opus 4.6:

### PR #17320 — Auth Bug Fix

- **Result**: `bug | high | needs-review`
- **Reasoning**: Correctly identified as genuine bug fix, well-scoped (2 files), noted missing tests
- **Cost**: $0.064

### PR #17296 — Kitchen-Sink PR

- **Result**: `bug | high | likely-duplicate`
- **Reasoning**: Correctly identified #17336 and #17279 as better-scoped alternatives, noted 24 files for a 1-line fix, flagged unfocused scope
- **Deterministic signals**: 4 file overlaps (0.71-0.83 Jaccard)
- **Cost**: $0.079

## Testing

```bash
# Dry run (no LLM call, deterministic signals only)
REPO=openclaw/openclaw PR_NUMBER=17320 GITHUB_TOKEN=$(gh auth token) \
  DRY_RUN=1 MAX_OPEN_PRS=10 node scripts/pr-triage.mjs

# Full run with LLM
REPO=openclaw/openclaw PR_NUMBER=17320 GITHUB_TOKEN=$(gh auth token) \
  ANTHROPIC_API_KEY=sk-ant-... MAX_OPEN_PRS=50 MAX_HISTORY=20 \
  node scripts/pr-triage.mjs

# Use cheaper model for testing
TRIAGE_MODEL=claude-haiku-4-5-20251001 TRIAGE_EFFORT=low \
  REPO=openclaw/openclaw PR_NUMBER=17320 GITHUB_TOKEN=$(gh auth token) \
  ANTHROPIC_API_KEY=sk-ant-... MAX_OPEN_PRS=50 \
  node scripts/pr-triage.mjs
```

## Design Decisions

| Decision               | Rationale                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------- |
| No embeddings          | Negation-blind per NevIR EACL 2024, fragile to model updates per Netflix/Cornell 2024 |
| No vector database     | LLM reads full context in one call — simpler, more accurate                           |
| No public bot comments | Community risk (matplotlib incident Feb 2026)                                         |
| No GitHub App          | Action is simpler, has native diff access, 2-file architecture                        |
| Labels only            | Non-intrusive, easily reversible, no notification spam                                |
| Structured output      | Prevents hallucinated formats, enables strict validation                              |
| Adaptive thinking      | Model decides when to think deeply vs respond quickly                                 |
| GraphQL batch fetch    | 25x more efficient than REST N+1 (1 call/50 PRs vs 1 call/PR)                         |
| Rate limit budget      | Graceful degradation to semantic-only when budget is low                              |
| 3-file split           | Each file under 400 lines for maintainability                                         |
