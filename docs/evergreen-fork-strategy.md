# Evergreen Fork Strategy

## Goal

Keep `radar-claw-defender` close to upstream OpenClaw without letting Radar-specific work sprawl across the upstream core.

The maintenance model is:

- `upstream/main`: canonical OpenClaw source
- `origin/main`: local mirror kept as close as possible to `upstream/main`
- `radar/main`: long-lived Radar integration branch
- `feature/*`: short-lived implementation branches based on `radar/main`

## Branch roles

### `main`

`main` should stay as close as possible to upstream.

Use it for:

- upstream sync
- conflict inspection against upstream
- confirming whether a behavior belongs to OpenClaw core or to Radar customization

Do not use it for:

- daily Radar feature work
- experiments
- Radar-only docs or tool expansion unless they are intentionally upstreamable

### `radar/main`

`radar/main` is the stable integration branch for this fork.

Use it for:

- Radar-first MCP integration work
- defensive review heuristics and config
- fork-specific docs
- controlled integration of upstream changes into Radar customizations

This is the real base branch for ongoing work in the fork.

### `feature/*`

All feature branches should branch from `radar/main`.

Examples:

- `feature/mcp-server`
- `feature/security-pipeline`
- `feature/skill-scan`
- `experiment/prompt-tuning`

Keep them short-lived and rebase or merge from `radar/main` regularly.

## Sync flow

Use the sync flow in this order:

1. `upstream/main -> origin/main`
2. `origin/main -> radar/main`
3. `radar/main -> feature/*`

That creates a clear separation between:

- upstream code
- Radar integration
- active implementation work

## Recommended commands

### Step 1: sync upstream into `main`

```bash
git checkout main
git fetch upstream main
git merge --ff-only upstream/main
git push origin main
```

### Step 2: sync `main` into `radar/main`

```bash
git checkout radar/main
git merge main
git push origin radar/main
```

### Step 3: refresh feature branches

```bash
git checkout feature/mcp-server
git merge radar/main
```

For a repeatable local helper, use `scripts/git/sync-radar-main.sh`.

## Isolation rules for Radar customizations

The fork stays healthy when Radar-specific work remains modular.

Prefer placing custom work in:

- `src/radar/*`
- `src/mcp/*`
- `config/radar/*`
- `docs/radar/*`

Avoid scattering Radar logic across broad upstream surfaces unless the change is truly foundational.

## Preferred customization pattern

Prefer:

- adapters
- wrappers
- explicit registries
- isolated config
- additive tool registration

Avoid when possible:

- deep rewrites of OpenClaw internals
- broad cross-cutting patches
- implicit behavior overrides hidden inside core paths
- fragile dependencies on private internal structure

## Decision rule

If you can choose between:

1. editing upstream core deeply
2. adding a Radar-specific wrapper or registration layer

prefer option 2.

## Conflict handling

When upstream changes break Radar work:

1. sync `upstream/main` into `main`
2. merge `main` into `radar/main`
3. resolve conflicts in `radar/main`
4. only then update feature branches

Do not resolve ongoing feature conflicts directly against `main` unless the change is being upstreamed.

## Why this model works

Benefits:

- upstream stays accessible
- merge conflicts stay localized
- Radar work has a stable base
- upstream refactors are easier to absorb

Costs:

- one more long-lived branch to maintain
- slightly more discipline in daily Git flow

For this fork, that tradeoff is worth it.
