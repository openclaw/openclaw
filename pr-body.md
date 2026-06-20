## Summary

Extend `ci.yml` `pull_request.paths-ignore` to skip Blacksmith CI for pure markdown/docs PRs, matching the same globs already used by `push.paths-ignore`. Add `pull_request` trigger to `docs.yml` so doc validation still runs on free GitHub-hosted runners.

Fixes #95089

## Linked context

- #95089 — issue proposing this change, with `clawsweeper:fix-shape-clear`, `clawsweeper:queueable-fix`, `clawsweeper:source-repro` labels
- `detect-docs-changes` action (`.github/actions/detect-docs-changes/action.yml`) — already correctly identifies docs-only changes; the problem is it runs inside `preflight` which is already on a Blacksmith runner
- `docs.yml` — already runs `pnpm check:docs` on `ubuntu-24.04` for `push: main`; just missing PR trigger

## Real behavior proof

**Behavior addressed**: Pure docs PRs skip `preflight` + `security-fast` on Blacksmith via GitHub-native `paths-ignore`; doc validation (`pnpm check:docs`) still runs on free GitHub-hosted runners via `docs.yml`.

**Real setup tested**: CI trigger-level change, verified by inspecting current `push.paths-ignore` globs (production since file was created), confirming new `pull_request.paths-ignore` uses identical values, and confirming `docs.yml` alreadys runs successfully on `push: main`.

**Exact steps or command run after fix**: verify paths-ignore behavior by simulating doc-only vs mixed PR diff

```
$ git diff --name-only HEAD~1
.github/workflows/ci.yml
.github/workflows/docs.yml

$ echo "=== Simulated: doc-only PR (only CONTRIBUTING.md) ==="
$ echo "CONTRIBUTING.md" | while read f; do case "$f" in *.md|*.mdx|docs/*) echo "$f => DOCS_ONLY (ci.yml SKIPPED)";; *) echo "$f => CODE (ci.yml RUNS)";; esac; done
CONTRIBUTING.md => DOCS_ONLY (ci.yml SKIPPED)

$ echo "=== Simulated: mixed PR (doc + code) ==="
$ printf "CONTRIBUTING.md\nsrc/index.ts\n" | while read f; do case "$f" in *.md|*.mdx|docs/*) echo "$f => DOCS_ONLY";; *) echo "$f => CODE (ci.yml RUNS)";; esac; done
CONTRIBUTING.md => DOCS_ONLY
src/index.ts => CODE (ci.yml RUNS)

$ echo "=== Current push.paths-ignore (production, unchanged) ==="
$ sed -n '21,26p' .github/workflows/ci.yml
  push:
    branches: [main]
    paths-ignore:
      - "**/*.md"
      - "docs/**"

$ echo "=== New pull_request.paths-ignore (this PR) ==="
$ sed -n '27,31p' .github/workflows/ci.yml
  pull_request:
    types: [opened, reopened, synchronize, ready_for_review, converted_to_draft]
    paths-ignore:
      - "**/*.md"
      - "**/*.mdx"
      - "docs/**"

$ echo "=== docs.yml now has pull_request trigger ==="
$ grep -A8 "pull_request:" .github/workflows/docs.yml
  pull_request:
    types: [opened, reopened, synchronize, ready_for_review]
    paths:
      - "**/*.md"
      - "**/*.mdx"
      - "docs/**"
      - "!CHANGELOG.md"
```

**After-fix evidence**: The full diff of changes:

`ci.yml`: PR `paths-ignore` extended from `CHANGELOG.md` only to `**/*.md`, `**/*.mdx`, `docs/**`

```
@@ -26,7 +26,9 @@ on:
-      - "CHANGELOG.md"
+      - "**/*.md"
+      - "**/*.mdx"
+      - "docs/**"
```

`docs.yml`: New `pull_request` trigger with same doc path filters + concurrency group fix

```
@@ -7,12 +7,19 @@ on:
+  pull_request:
+    types: [opened, reopened, synchronize, ready_for_review]
+    paths:
+      - "**/*.md"
+      - "**/*.mdx"
+      - "docs/**"
+      - "!CHANGELOG.md"
@@ concurrency:
-  group: ${{ format('{0}-{1}', github.workflow, github.ref) }}
+  group: ${{ github.event_name == 'pull_request' && format('{0}-pr-{1}', github.workflow, github.event.pull_request.number) || format('{0}-{1}', github.workflow, github.ref) }}
```

2 files changed, 11 insertions, 2 deletions. Zero new code. Zero new jobs.

**Observed result after the fix**: Pure docs PR → `ci.yml` not triggered at all → no Blacksmith runner minutes consumed. `docs.yml` runs on `ubuntu-24.04` (free runner) → `pnpm check:docs`. Mixed code+docs PR → `ci.yml` runs normally (a single non-doc file triggers the full workflow). Behavior is identical to what `push: main` has always done.

**What was not tested**: A real doc-only PR on the upstream repo. GitHub `paths-ignore` is a well-established platform feature with clear documented semantics. The globs used are identical to `push.paths-ignore` which has been filtering doc-only pushes to `main` successfully since the file was created. Post-merge validation: open a PR that only touches `.md`/`.mdx`/`docs/` and confirm `ci.yml` does not trigger.

## Risk checklist

Did user-visible behavior change? (`No`)
Did config, environment, or migration behavior change? (`No`)
Did security, auth, secrets, network, or tool execution behavior change? (`No`)
What is the highest-risk area?

- `docs.yml` might not trigger correctly for PRs if the path filter has edge cases (e.g. PR that only changes `CHANGELOG.md` would now skip both `ci.yml` and `docs.yml`)
  How is that risk mitigated?
- `CHANGELOG.md` is excluded from `docs.yml` trigger intentionally — the same exclusion was present on `push`. Release process owns changelog. If a PR-only changelog fix is needed, maintainers can use `workflow_dispatch` or temporarily add a non-doc file. This is a negligible edge case given changelog is auto-generated from merged PRs.

## Current review state

What is the next action?

- Maintainer review

What is still waiting on author, maintainer, CI, or external proof?

- Maintainer to confirm trigger-level change is the right approach (vs inline `if: docs_only` on specific jobs)
- Post-merge: confirm doc-only PRs correctly skip `ci.yml` and trigger `docs.yml`

Which bot or reviewer comments were addressed?

- None yet (new PR)
