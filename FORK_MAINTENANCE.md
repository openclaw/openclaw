# Fork Maintenance

`mctl-openclaw` is a fork of [`openclaw/openclaw`](https://github.com/openclaw/openclaw). Treat `openclaw/openclaw` as the canonical upstream and keep this repository as a thin patch layer on top.

This document describes how the upstream sync pipeline actually behaves today (see `.github/workflows/upstream-sync.yml` and `.github/workflows/upstream-sync-release.yml`), what to do when it fails, and which fork-specific areas must be reviewed on every sync PR.

## Upstream Sync Workflow

The default maintenance mode is a weekly sync PR from `upstream/main` into this fork's `main`.

- Workflow: `.github/workflows/upstream-sync.yml`.
- Schedule: every Monday at 07:00 UTC (`cron: "0 7 * * 1"`). Manual trigger with `gh workflow run upstream-sync.yml -R mctlhq/mctl-openclaw` (no inputs required).
- Branch: `sync/upstream-YYYY-MM-DD`, created and force-pushed by `github-actions[bot]`.
- Merge strategy: `git merge --no-ff --no-edit upstream/main` into `origin/main`. Merge commits only — do not rebase fork history.
- Guard: if `upstream/main` is already an ancestor of `origin/main`, the workflow exits early with `changed=false` and no PR is created.
- PR title: `chore(sync): merge upstream/main into main (sync/upstream-YYYY-MM-DD)`.
- PR body: templated from `.github/upstream_sync_pr_template.md` with `{{UPSTREAM_SHA}}` and `{{BASE_SHA}}` interpolated.
- Codex review is triggered automatically (see "Codex Review Gate" below).

### Handling Conflicts

The sync step runs under `set -euo pipefail`, so `git merge` exiting non-zero (i.e. any conflict) **fails the workflow**. When that happens:

- No `sync/upstream-YYYY-MM-DD` branch is pushed.
- No PR is created.
- No Codex review trigger is posted.

Recovery is manual. From a clean local checkout of `main`:

```bash
git fetch origin main --prune --tags
git fetch upstream main --prune --tags

branch="sync/upstream-$(date -u +%Y-%m-%d)"
git checkout -B "$branch" origin/main
git merge --no-ff --no-edit upstream/main   # will leave conflict markers

# resolve each conflicted file, group fixes by the areas listed below
git add -u
git commit --no-edit                         # finalize the merge commit

git push -u origin "$branch"
```

Open the PR against `main` with the same title format (`chore(sync): merge upstream/main into main (sync/upstream-YYYY-MM-DD)`) and the body from `.github/upstream_sync_pr_template.md`. Tick the "Conflict resolution was needed" box and list every touched area with a one-line resolution note — that checklist is how reviewers know what to double-check.

Then post `@codex review` as a top-level PR comment to kick off Codex (the workflow does this automatically on the happy path; on manual recovery it is your responsibility).

## Codex Review Gate

Every sync PR — happy path or manually recovered — must pass Codex review before merge. This is a manual gate; nothing in GitHub Actions blocks merges on Codex findings.

- Trigger comment: `@codex review`. On the automated path, the workflow posts it exactly once per PR (deduplicated by the `<!-- codex-review-trigger -->` marker) after the PR is created or updated. On manual recovery, post it yourself.
- Fetch findings:
  ```bash
  gh api "repos/mctlhq/mctl-openclaw/pulls/<N>/comments" \
    --jq '.[] | select(.user.login | test("codex"; "i")) | {path, line, body}'
  ```
  Also check top-level comments — Codex may post a summary there:
  ```bash
  gh api "repos/mctlhq/mctl-openclaw/issues/<N>/comments" \
    --jq '.[] | select(.user.login | test("codex"; "i")) | {body, created_at}'
  ```
- For each finding, either push a fix-up commit to the sync branch or dismiss it publicly in-thread with a short justification. The mctlhq house rule is "every PR must be reviewed by Codex before merge"; sync PRs are no exception.
- After pushing fixes, re-request review by posting another `@codex review` comment; previous comments stay as an audit trail.
- Merge is only allowed when: CI is green, every Codex finding is resolved (fixed or dismissed with justification), and the conflict-resolution checklist in the PR body is filled in.

Merge command (merge commit, not squash — fork branch history stays visible in the graph):

```bash
gh pr merge <N> -R mctlhq/mctl-openclaw --merge --delete-branch
```

## Fork-Specific Patch Areas

These are the files mctl-openclaw currently overlays on top of upstream. Review every sync PR against this list — that is where conflicts and regressions concentrate. Regenerate at any time with:

```bash
git diff --name-only "$(git merge-base upstream/main main)" main
```

### Workflows, packaging, and top-level docs

- `.github/workflows/ci.yml`, `.github/workflows/docker-release.yml`, `.github/workflows/install-smoke.yml`, `.github/workflows/labeler.yml`, `.github/workflows/workflow-sanity.yml` — mctl jobs and labels layered into upstream CI.
- `.github/workflows/mctl-ci.yml`, `.github/workflows/upstream-sync.yml`, `.github/workflows/upstream-sync-release.yml`, `.github/upstream_sync_pr_template.md` — fork-only; upstream has no analogue.
- `Dockerfile` (patched), `Dockerfile.whisper-cache-builder` (fork-only).
- `FORK_MAINTENANCE.md` (this file).

### mctl identity, skills, and OAuth

- `src/mctl-identity/*` (`AGENTS.md`, `CLAUDE.md`, `IDENTITY.md`, `SOUL.md`, `TOOLS.md`, `USER.md`) — fork-only platform identity overlay.
- `src/mctl-skills/mctl-platform/SKILL.md` — fork-only.
- `src/mctl/oauth-store.ts` — fork-only.
- `src/gateway/server-methods/mctl.ts`, `src/gateway/server-methods/codex.ts`, `src/gateway/server-methods.mctl.test.ts` — fork-only gateway methods registered through upstream's `server-methods.ts`.

### Gateway integration (high conflict risk)

- `src/gateway/auth.ts`, `src/gateway/method-scopes.ts`, `src/gateway/server-methods.ts`, `src/gateway/server-methods-list.ts`, `src/gateway/server.auth.control-ui.suite.ts`, `src/gateway/server/ws-connection/message-handler.ts`.

Review focus: Trusted-proxy assumptions, Control UI auth, `mctl.*` method registration, and that `server-methods-list.ts` still exports every mctl method. Keep `server-methods.mctl.test.ts` passing.

### OAuth, agents, and Codex

- `src/agents/auth-profiles/oauth.ts`, `src/agents/auth-profiles/store.ts`, `src/agents/auth-profiles/oauth.openai-codex-refresh-fallback.test.ts`.
- `src/agents/openclaw-tools.ts`, `src/agents/tools/mctl-agent-external-tool.ts`, `src/agents/tools/mctl-agent-external-tool.test.ts`.
- `src/openai-codex/connect-flow.ts`, `src/openai-codex/connect-flow.test.ts`, `src/openai-codex/connect-store.ts`, `src/openai-codex/connect-store.test.ts`.

Review focus: silent refresh behavior for `mctl.connect.status`, serialized refresh-token rotation (`fix/mctl-refresh-race` behavior), Codex localhost/manual callback flow, and auth persistence.

### Auto-reply

- `src/auto-reply/reply/commands-system-prompt.ts`, `src/auto-reply/reply/commands-system-prompt.test.ts`, `src/auto-reply/reply/get-reply.ts`.
- `src/auto-reply/reply/skill-filter.ts`, `src/auto-reply/reply/skill-filter.test.ts` (fork-only skill-filter layer).

Review focus: `get-reply.ts` must still call the mctl skill filter; incident hook sessions must remain scoped to platform skills.

### Infra, config, commands, plugins, shared

- `src/infra/json-file.ts`, `src/infra/json-file.test.ts` — atomic-write layer with symlink-chain walk and fail-loud behavior on unmounted symlink targets. Before merging upstream changes, check whether upstream introduced its own atomic write; if so, take upstream and re-apply the mctl-only behaviors on top.
- `src/infra/update-check.ts`, `src/infra/update-startup.ts`, `src/infra/update-startup.test.ts` — mctl version banner wiring.
- `src/config/schema.help.ts`, `src/config/types.gateway.ts`, `src/config/zod-schema.ts`.
- `src/commands/onboard-auth.test.ts`, `src/commands/status.update.ts`, `src/commands/status.update.test.ts`.
- `src/plugins/provider-auth-helpers.ts`.
- `src/shared/semver.ts`.
- `src/docker-image-digests.test.ts`.

### UI

- `ui/src/ui/app.ts`, `ui/src/ui/app-chat.ts`, `ui/src/ui/app-gateway.ts`, `ui/src/ui/app-gateway.node.test.ts`, `ui/src/ui/app-lifecycle.ts`, `ui/src/ui/app-polling.ts`, `ui/src/ui/app-render.ts`, `ui/src/ui/app-settings.ts`, `ui/src/ui/app-settings.test.ts`, `ui/src/ui/app-view-state.ts`, `ui/src/ui/types.ts`.
- `ui/src/ui/chat/slash-command-executor.ts`, `ui/src/ui/chat/slash-commands.ts`.
- `ui/src/ui/views/overview.ts`.
- `ui/src/ui/views/chat.test.ts` — **note:** upstream has deleted this file in a more recent commit. On the next sync the merge will conflict with the deletion; accept the deletion unless mctl-specific assertions here still cover behavior that has not moved elsewhere, in which case port them into the matching upstream test file.
- `ui/src/ui/controllers/codex-connect.ts`, `ui/src/ui/controllers/mctl-connect.ts` — fork-only controllers.

### Platform-specific deployment

- Health endpoints, worker templates, MCTL-specific ingress/auth wiring, and any path that depends on GitOps rather than upstream defaults. These live primarily in `mctlhq/mctl-gitops`; their contracts with this repo (image tag, environment variables, health paths) must not regress.

## Release Flow (After a Sync PR Merges)

Triggered by `.github/workflows/upstream-sync-release.yml` on `pull_request` type `closed` against `main`, gated on `merged == true` and `head.ref` starting with `sync/upstream-`.

What it does:

1. Reads `package.json` version (must match `YYYY.M.D` or `YYYY.M.D-beta.N`).
2. Creates an annotated tag `v<version>`; if the tag already exists, appends `-1`, `-2`, … until unique.
3. Pushes the tag to `origin`.
4. Calls `actions.createWorkflowDispatch` on `mctlhq/mctl-gitops` → `build-image.yaml` with `image_name=ghcr.io/mctlhq/openclaw`, `image_tag=<version>`, `git_ref=<tag>`, `team_name=labs`, `component_name=openclaw`.

There is no gate on the gitops dispatch succeeding — it is fire-and-forget. After the sync PR merges, manually verify:

1. The `upstream-sync-release` job ran to the `createWorkflowDispatch` step without errors.
2. In `mctlhq/mctl-gitops` Actions, `build-image.yaml` started and produced `ghcr.io/mctlhq/openclaw:<version>`.
3. ArgoCD reports `labs-openclaw` as `Synced Healthy` on the new tag.
4. Smoke checks:
   - `mctl` connect, `mctl.connect.status`, and refresh.
   - Codex connect.
   - Hook endpoint reachability (mctl-agent webhook).
   - One basic chat/session round trip.

Do not promote a sync to other tenants until `labs-openclaw` is healthy.

### Rollback

Do not revert the sync merge in `main` — upstream merges bring in thousands of commits and a revert will corrupt history. Instead:

- In `mctlhq/mctl-gitops`, pin the `labs-openclaw` image tag back to the last known-good fork tag; ArgoCD returns to healthy.
- Open a hotfix branch off `main`, fix forward, open a new PR, complete the Codex gate, merge; the release workflow will cut a new tag.

## Manual Sync Quick-Start

```bash
# 1. Trigger the workflow (happy path).
gh workflow run upstream-sync.yml -R mctlhq/mctl-openclaw

# 2. If the workflow succeeds, find the PR; otherwise see "Handling Conflicts" above.
gh pr list -R mctlhq/mctl-openclaw --head "sync/upstream-$(date -u +%Y-%m-%d)"

# 3. Fetch Codex findings.
gh api "repos/mctlhq/mctl-openclaw/pulls/<N>/comments" \
  --jq '.[] | select(.user.login | test("codex"; "i")) | {path, line, body}'
gh api "repos/mctlhq/mctl-openclaw/issues/<N>/comments" \
  --jq '.[] | select(.user.login | test("codex"; "i")) | {body, created_at}'

# 4. Address each finding (commit to the sync branch, then re-request review).
gh pr comment <N> -R mctlhq/mctl-openclaw --body "@codex review"

# 5. Once CI is green and Codex is satisfied, merge.
gh pr merge <N> -R mctlhq/mctl-openclaw --merge --delete-branch
```

## What Should Stay Fork-Only

Keep changes fork-only when they depend on:

- MCTL OAuth or control-plane specifics.
- Trusted-proxy behavior unique to the platform.
- `mctl-agent` webhook contracts.
- Tenant/GitOps deployment conventions (image names, ArgoCD apps, tag shapes).

Upstream generic fixes whenever the change is broadly useful and does not rely on MCTL-only behavior — open a PR to `openclaw/openclaw` directly.
