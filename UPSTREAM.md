# Upstream workflow (OpenClaw fork)

This repo is a **fork** of OpenClaw with **Crittora security hardening** and related product changes.

## Mental model

- **`main` = our product code** (what the team develops on)
- **`vendor/openclaw` = upstream mirror** (read-only snapshot of official OpenClaw)
- Feature work always branches from **`main`**
- Upstream updates land via a PR that merges **`vendor/openclaw` → `main`**

## Remotes

- `origin` → this fork (Crittora)
- `upstream` → official OpenClaw

One-time setup:

```bash
git remote add upstream <OPENCLAW_UPSTREAM_GIT_URL>
git remote -v
```

## Branches

### Long-lived

- `main` — Crittora-hardened OpenClaw (default branch)
- `vendor/openclaw` — mirror of `upstream/main` (do not develop here)

### Short-lived

- `feature/<area>-<short>` — features off `main`
- `hotfix/<area>-<short>` — urgent fixes off `main`
- `chore/upstream-<upstreamVersion>` — upstream update PR branch (off `main`)
- `release/<yyyy.mm.dd>-<n>` — release cut branch (off `main`)

## Day-to-day development

```bash
git checkout main
git pull

git checkout -b feature/<area>-<short>
# work, commit

git push -u origin feature/<area>-<short>
# open PR -> main
```

## Updating from upstream (maintainers)

### Step 1 — Refresh the upstream mirror branch

```bash
git fetch upstream

# Update local mirror branch to exactly match upstream
# (safe because this branch is treated as read-only)
git checkout -B vendor/openclaw upstream/main

git push -u origin vendor/openclaw --force-with-lease
```

> Policy: **Never commit directly** to `vendor/openclaw`.

### Step 2 — Merge upstream into our `main` via PR (recommended)

Create a branch off `main`, merge the mirror, resolve conflicts, run CI, then PR to `main`:

```bash
git checkout main
git pull

git checkout -b chore/upstream-<upstreamVersion>

git merge origin/vendor/openclaw
# resolve conflicts if any

git push -u origin chore/upstream-<upstreamVersion>
# open PR: chore/upstream-<upstreamVersion> -> main
```

Why merge (vs rebase)?

- Team-friendly (no rewriting `main`)
- Keeps active feature branches stable
- Makes upstream updates auditable as a single PR

### Optional: Rebase strategy (only if you intentionally rewrite history)

Only use if you understand the impact on in-flight branches:

```bash
git checkout main
git pull

git rebase origin/vendor/openclaw

git push --force-with-lease
```

## Releases & tags

Releases are cut from `main`.

### Release branch

```bash
git checkout main
git pull

git checkout -b release/<yyyy.mm.dd>-<n>
git push -u origin release/<yyyy.mm.dd>-<n>
```

### Tag naming

Tags must encode the upstream base + our hardening iteration:

- `crittora-openclaw-<upstreamVersion>+sec.<n>`

Example:

```bash
git tag -a crittora-openclaw-2026.2.18+sec.1 -m "Security hardening release 1 on OpenClaw 2026.2.18"
git push origin --tags
```

## Post-upstream-update checklist (security)

After merging upstream into `main`, re-verify:

- Gateway auth defaults (password/token mode, rotation expectations)
- Bind/listen behavior (loopback vs 0.0.0.0) and any TLS/proxy assumptions
- Tool allow/deny policy changes (agents/tools permissions)
- Plugin enablement defaults (e.g., messaging/WhatsApp)
- Command denylist / sensitive capabilities (camera/screen/calendar/contacts, etc.)
- Any config schema changes affecting our hardened defaults

## Do / Don’t

✅ Do

- Branch features from `main`
- Update upstream via PR (merge `vendor/openclaw` into `main`)
- Keep `vendor/openclaw` as a clean mirror

❌ Don’t

- Don’t develop on `vendor/openclaw`
- Don’t force-push `main` unless you explicitly chose the rebase workflow
- Don’t merge upstream directly into a long-lived feature branch (merge into `main` first)
