# OpenClaw Patch Management

> This file documents all local patches applied on top of upstream openclaw.
> **Never** manually edit patched files without updating this document.

## Patch Philosophy

We maintain two categories of patches:

1. **Feature branches** (on `feat/otel-genai-semconv` and similar) — clean commits
   intended for upstream PRs. These should be kept rebased on upstream `main` and
   submitted as PRs. If upstream merges them, we drop the branch.

2. **Local-only patches** (stashed as `stash@{0}`) — changes upstream won't
   merge (OpenAI HTTP `/v1/models` endpoint). These live in a dedicated
   `local/openai-models-endpoint` branch and get rebased on every upgrade.

---

## Active Patches

### 1. `feat/otel-genai-semconv` — OTEL + Langfuse integration

**Branch:** `feat/otel-genai-semconv`  
**Target upstream PR:** TBD (not yet submitted)  
**Status:** 4 commits ahead of `main`

| Commit     | Description                                                                                  | Files                                                                                                                  |
| ---------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `6e6b3fa`  | feat(diagnostics-otel): add OpenTelemetry GenAI semantic conventions to trace spans          | `extensions/diagnostics-otel/src/service.ts`                                                                           |
| `c8a7b6a`  | fix: guard langfuse.session.id against empty string in model.usage spans                     | `extensions/diagnostics-otel/src/service.ts`                                                                           |
| `68fa14fe` | feat(otel): add Langfuse user tracking, observation types, content opt-in, stuck trace dedup | `extensions/diagnostics-otel/src/service.ts`, `src/auto-reply/reply/agent-runner.ts`, `src/infra/diagnostic-events.ts` |
| `646270ac` | feat(config): add includeContent to OTEL config schema                                       | `src/config/zod-schema.ts`, `src/config/types.base.ts`, `src/config/schema.help.ts`, `src/config/schema.labels.ts`     |

**Conflict risk on 3.7 upgrade:**

- `service.ts`: import path changed upstream (`plugin-sdk` → `plugin-sdk/diagnostics-otel`) — needs manual fix
- `zod-schema.ts`: upstream added new config fields in same area — likely clean but verify
- `agent-runner.ts`: 28 upstream diff lines — review before rebase

---

### 2. `local/openai-models-endpoint` — OpenAI HTTP `/v1/models` endpoint

**Branch:** `local/openai-models-endpoint` _(to be created from stash)_  
**Target upstream PR:** None (local-only, exposes agents as OpenAI model list)  
**Status:** In `stash@{0}` (v2026.2.26-patches-backup)

**Files patched:**

- `src/gateway/openai-http.ts` — adds `GET /v1/models` handler, returns agents as OpenAI model objects
- `src/gateway/open-responses.schema.ts` — minor schema extension
- `src/gateway/openresponses-http.ts` — response handling additions

**Conflict risk on 3.7 upgrade:**

- `openai-http.ts`: upstream added full image handling (~150 new lines in import/type section). Our additions (models handler, ~75 lines) are at the bottom — likely clean rebase but file is substantially larger.

---

## Upgrade Runbook (v2026.3.2 → v2026.3.7)

### Step 1: Fetch upstream 3.7

```bash
cd ~/openclaw-src
git fetch origin
git fetch origin tag v2026.3.7
```

### Step 2: Save current state

```bash
# Ensure stash is current
git stash list  # stash@{0} should be openai-http patches
# Branch feat/otel-genai-semconv is already committed
```

### Step 3: Create local-only branch from stash (if not done)

```bash
git checkout main
git checkout -b local/openai-models-endpoint
git stash apply stash@{0}
git add -p  # review before committing
git commit -m "local: add GET /v1/models endpoint for OpenAI HTTP interface"
git checkout feat/otel-genai-semconv
```

### Step 4: Rebase OTEL branch onto 3.7

```bash
git checkout feat/otel-genai-semconv
git rebase v2026.3.7
# Expected conflict: service.ts import path
# Fix: change `from "openclaw/plugin-sdk"` → `from "openclaw/plugin-sdk/diagnostics-otel"`
# Continue rebase for each commit
git rebase --continue
```

### Step 5: Rebase local-only branch onto 3.7

```bash
git checkout local/openai-models-endpoint
git rebase v2026.3.7
# Expected: minor conflict in openai-http.ts (new image handling imports)
# Our models handler is additive at bottom — resolve by keeping both
git rebase --continue
```

### Step 6: Build and test

```bash
# Merge both patch branches onto a test branch
git checkout -b test/upgrade-3.7
git merge feat/otel-genai-semconv
git merge local/openai-models-endpoint

# Build
pnpm build 2>&1 | tail -20

# Smoke test
openclaw doctor
curl -s http://localhost:18799/v1/models -H "Authorization: Bearer $(openclaw gateway token)" | python3 -m json.tool | head -20
```

### Step 7: Deploy to prod runtime

```bash
# If tests pass — copy built dist to runtime
cp -r dist ~/.openclaw/dist-backup-$(date +%Y%m%d)
cp -r dist ~/.openclaw/
openclaw gateway restart
```

### Step 8: Push OTEL branch to fork for upstream PR

```bash
git push fork feat/otel-genai-semconv --force-with-lease
# Then open PR on GitHub: lazmo88/openclaw → openclaw/openclaw
```

---

## PR Submission Checklist

Before opening upstream PRs:

- [ ] Commits are clean, atomic, conventional commit format
- [ ] `pnpm test` passes locally
- [ ] `openclaw doctor` clean
- [ ] No local-only stuff (API keys, personal config) in the diff
- [ ] PR description explains the _why_, not just the what
- [ ] If upstream requests changes: update commits, `git push fork --force-with-lease`, same PR

---

## Compatibility Test Script

```bash
#!/bin/bash
# scripts/patch-compat-test.sh
set -e

echo "=== Patch Compatibility Test ==="

echo "1. Build check..."
pnpm build 2>&1 | grep -E "error|warning|✓" | tail -5

echo "2. Config validation..."
openclaw doctor

echo "3. /v1/models endpoint..."
TOKEN=$(openclaw gateway token 2>/dev/null)
curl -sf http://localhost:18799/v1/models \
  -H "Authorization: Bearer $TOKEN" | python3 -c "
import sys,json
d=json.load(sys.stdin)
models = d.get('data', d) if isinstance(d, dict) else d
print(f'  Models returned: {len(models)}')
"

echo "4. OTEL schema validation..."
openclaw doctor 2>&1 | grep -i "otel\|diagnostics\|unrecognized" || echo "  No OTEL schema errors"

echo "=== All checks passed ==="
```

---

## Notes

- `main` branch always tracks upstream `origin/main` — never commit patches directly to `main`
- Prod runtime binary is separate from src — update via `openclaw update` or manual `cp dist/`
- Keep this file updated whenever a patch is added, removed, or sent upstream
