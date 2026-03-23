# VIDA Sync Workflow

This is the repeatable process for syncing upstream OpenClaw into the VIDA fork (both `main` and releases) and validating downstream Docker compatibility.

## 1) Sync upstream main into fork main

Run from `openclaw`:

```sh
cd /home/lylepratt/workspace/openclaw
scripts/sync-upstream-main.sh
```

Default behavior:

- fetches `upstream` + `origin`
- checks out `main`
- rebases local `main` to `origin/main`
- merges `upstream/main` into `main`
- pushes `main`

Useful variants:

```sh
# Preview only
scripts/sync-upstream-main.sh --dry-run

# Do not push
scripts/sync-upstream-main.sh --no-push

# Custom target/source
scripts/sync-upstream-main.sh --target-branch main --source-ref upstream/main
```

If conflicts happen:

- default handoff file: `tmp/codex-handoff-main-main.md`

Optional handoff controls:

```sh
scripts/sync-upstream-main.sh --no-codex-handoff
scripts/sync-upstream-main.sh --codex-handoff-path /tmp/main-sync-handoff.md
```

## 2) Sync latest upstream release into fork

Run from `openclaw`:

```sh
cd /home/lylepratt/workspace/openclaw
scripts/sync-upstream-release.sh
```

Default behavior:

- resolves latest upstream non-beta tag (`v*`)
- creates `release-sync/<tag>` from the upstream release tag itself
- leaves the branch exactly on that release unless you intentionally add fork-only hotfix commits
- pushes branch
- creates and pushes fork tag `vida-<tag>` (example: `vida-v2026.2.14`)
- runs downstream verifier (`scripts/verify-vida-release.sh`)

If you need a fork-only hotfix on top of a release:

- create the release-sync branch from the upstream tag
- cherry-pick or commit only the intended hotfixes
- then create the `vida-<tag>` fork tag from that branch

Useful variants:

```sh
# Explicit release tag/branch/tag-name
scripts/sync-upstream-release.sh \
  --tag v2026.2.14 \
  --branch release-sync/v2026.2.14 \
  --fork-tag vida-v2026.2.14

# Preview only
scripts/sync-upstream-release.sh --dry-run

# Skip verifier
scripts/sync-upstream-release.sh --no-verify
```

## 3) If release merge conflicts happen

When the merge fails, the script writes a Codex handoff prompt file:

- default path: `tmp/codex-handoff-<tag>.md`
- includes unresolved files and exact next steps

Then resolve conflicts, commit, and push:

```sh
git add <resolved files>
git commit
git push -u origin <release-sync-branch>
git push origin <fork-tag>
```

Optional handoff controls:

```sh
# Disable handoff generation
scripts/sync-upstream-release.sh --no-codex-handoff

# Custom handoff file path
scripts/sync-upstream-release.sh --codex-handoff-path /tmp/my-handoff.md
```

## 4) Re-run downstream compatibility checks

Run from `openclaw`:

```sh
scripts/verify-vida-release.sh --fork-tag vida-v2026.2.14
```

What it verifies:

- fork tag exists on `origin`
- fork tag stays close to the intended upstream release tag instead of drifting to `main`
- `openclaw-docker` build/push previews use expected `OPENCLAW_REF`
- expected Docker image tag derivation (for example `vida-v2026.2.14` -> `2026-02-14`)
- `--no-cache` and `--push` flags are present where expected

Useful variants:

```sh
# Verify a different docker ref
scripts/verify-vida-release.sh --fork-tag vida-v2026.2.14 --openclaw-ref vida-v2026.2.14

# Skip docker checks
scripts/verify-vida-release.sh --skip-docker
```

## 5) Docker publish usage (openclaw-docker)

```sh
cd /home/lylepratt/workspace/openclaw-docker
GITHUB_TOKEN=<github_pat_with_repo_access> make push
```

Default pushed image tag is date-style, e.g.:

- `vidaislive/openclaw-docker:2026-02-14`
