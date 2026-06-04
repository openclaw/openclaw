# Polytropos (OpenClaw fork)

Polytropos is a fork of **OpenClaw** focused on one thing: **making feature work cheap**.

OpenClaw already has a powerful plugin system; the problem we kept hitting in practice was that “quick additions” often turn into a pile of ad‑hoc patches, scripts, and one-off deployments. Polytropos formalizes a workflow where:

- most changes live in **plugins** (fast iteration, low risk)
- when core changes are needed, they are **tiny, explicit seams** (mergeable, reviewable)

This repository is the *core fork* (the runtime + loader). Plugins live in a separate repo (see below).

## Canonical Polytropos README

For Polytropos-specific documentation, treat **this file** as the canonical readme.

- `README.md` is retained primarily as the upstream OpenClaw README (with a small Polytropos header).
- Polytropos docs live under [`docs/polytropos/`](docs/polytropos/).

---

## Repos

- **Core fork:** `openclaw-polytropos` (this repo)
- **Plugins monorepo:** [`polytropos-plugins`](https://github.com/JoshuaCWebDeveloper/polytropos-plugins)

## Branch Architecture

A development clone should define two remotes:
- `origin` (pointing to this repo)
- `upstream` (pointing to https://github.com/openclaw/openclaw)

### Upstream refs
- `upstream/main` — latest OpenClaw trunk; not guaranteed to correspond to a release.
- `upstream/release/YYYY.M.D` — release branch for a specific OpenClaw release.
- `upstream/vYYYY.M.D` — tag for a specific OpenClaw release.

### Origin refs
- `origin/master` — the long-lived Polytropos fork branch.
- `origin/release/YYYY.M.D` — a Polytropos release-preparation branch created from a target upstream release tag/branch, then updated by merging `origin/master` into it.
- `origin/vYYYY.M.D+poly.N` — a Polytropos release tag.
- `origin/main` — legacy branch with incorrect historical release merges; not authoritative for update/release work.

### Operational rule
- **Updates** start from the target upstream release ref and happen on `origin/release/YYYY.M.D`.
- **Releases** are cut from `origin/release/YYYY.M.D`.
- **Do not** use `origin/main` for update or release work.

See also:
- [`docs/polytropos/UPDATE-PROCEDURE.md`](docs/polytropos/UPDATE-PROCEDURE.md)
- [`docs/polytropos/CORE-RELEASES.md`](docs/polytropos/CORE-RELEASES.md)

---

## Non-negotiable invariants

These invariants exist because we already paid the price of getting them wrong.

### Runtime config stability
Polytropos continues to use the **same config file**:

- `~/.openclaw/openclaw.json`

If we need to introduce new *core* config keys for the fork, they should be:

- namespaced under a single top-level object: `polytropos.*`
- additive (safe defaults)

Plugin config continues to live where it already lives today (plugin entry config in the same file).

### Extension deployment location
Plugins deploy to:

- `~/.openclaw/extensions/<pluginId>`

### Manifest + plugin root rules
OpenClaw/Polytropos loads plugins via a manifest.

- The manifest we package is `openclaw.plugin.json`
- **Plugin root** is the directory that **contains** `openclaw.plugin.json`

Our plugin toolchain enforces this (see `polytropos-plugins/scripts/deploy-plugin.mjs`).

### Plugin deployment modes (polytropos-plugins)
Plugin deployment mode policy is defined in the **plugins repo**, not the fork.

See: https://github.com/JoshuaCWebDeveloper/polytropos-plugins

---

## The pattern for making changes

### All feature work lives in plugins
Polytropos is plugin-first by design. **Feature implementation does not go into the fork.**

### The only allowed core-fork changes
Changes submitted to this fork must be exactly one of:

1) **New events / hook points** that plugins can consume
2) **New config keys + logic gates** (namespaced under `polytropos.*`, additive defaults)
3) **New log lines** (diagnostics/observability)

If a change doesn’t fit one of those buckets, it doesn’t belong in the fork.

### How we ship a new capability
1) Implement the capability in `polytropos-plugins` (new plugin or change an existing plugin).
2) If the plugin cannot do the job with existing hooks/config/logs:
   - add the smallest possible **allowed** core change
   - document any new events/hooks in [`docs/polytropos/POLYTROPOS-EVENTS.md`](docs/polytropos/POLYTROPOS-EVENTS.md)
3) Verify in runtime.

---

## Where to put things

- Long-lived fork docs: [`docs/polytropos/`](docs/polytropos/) (with this overview kept at repo root)
- Work-in-progress plans: [`docs/polytropos/planning/`](docs/polytropos/planning/)
- Plugins: **do not** land in this repo; they live in `polytropos-plugins`

---

## Current planning status

See:

- [`docs/polytropos/planning/ROADMAP.md`](docs/polytropos/planning/ROADMAP.md)
- [`docs/polytropos/planning/PLUGIN-CONTRACT.md`](docs/polytropos/planning/PLUGIN-CONTRACT.md)

M0/M2 are complete (plugin pipeline + migration workflow). Next major milestone is **M1: fork skeleton** (core seams + minimal namespace / structure for Polytropos-specific behavior).
