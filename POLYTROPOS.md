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

The following `upstream` branches and tags are used:
- `upstream/main` - the default branch for the OpenClaw repo. Contains a trunk of the latest work, but may or may not include actual releases.
- `upstream/release/YYYY.MM.DD` - a branch for a specific OpenClaw release that will not be merged into `upstream/main`.
- `upstream/vYYYY.MM.DD` - a tag for an OpenClaw release.

The following `origin` branches and tags are used:
- `origin/master` - the default branch for the Polytropos repo. Intentionally kept behind `upstream/main` by at least several releases.
- `origin/release/YYYY.MM.DD` - a branch for a specific Polytropos release. Will have `origin/master` merged into it as a part of the release. Will often be based off the corresponding `upstream/release/YYYY.MM.DD` branch, but there is no hard rule on this.
- `origin/vYYYY.MM.DD+poly.N*` - a tag for a Polytropos release
- `origin/main` - A legacy branch that had releases incorrectly merged into it. Will be force reset to `upstream/main` at some point.

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
