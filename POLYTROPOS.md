# Polytropos (OpenClaw fork)

Polytropos is a fork of **OpenClaw** focused on one thing: **making feature work cheap**.

OpenClaw already has a powerful plugin system; the problem we kept hitting in practice was that “quick additions” often turn into a pile of ad‑hoc patches, scripts, and one-off deployments. Polytropos formalizes a workflow where:

- most changes live in **plugins** and **scripts** (fast iteration, low risk)
- when core changes are needed, they are **tiny, explicit seams** (mergeable, reviewable)

This repository is the *core fork* (the runtime + loader). Plugins live in a separate repo (see below).

---

## Repos

- **Core fork:** `openclaw-polytropos` (this repo)
- **Plugins monorepo:** `polytropos-plugins`

Canonical local dev root (per our workflow):

- `/home/ec2-user/polytropos-dev/`

---

## Non-negotiable invariants

These invariants exist because we already paid the price of getting them wrong.

### Runtime config stability
Polytropos should run with an unchanged default config file:

- `~/.openclaw/openclaw.json`

If a feature requires a new config key, prefer:

1) **optional** config (safe default)
2) config that is local to a plugin entry (`plugins.entries.<id>.config`)

### Extension deployment location
Plugins deploy to:

- `~/.openclaw/extensions/<pluginId>`

### Manifest + plugin root rules
OpenClaw/Polytropos loads plugins via a manifest.

- The manifest we package is `openclaw.plugin.json`
- **Plugin root** is the directory that **contains** `openclaw.plugin.json`

Our plugin toolchain enforces this (see `polytropos-plugins/scripts/deploy-plugin.mjs`).

### Dev vs prod deployments
We use two deployment modes:

- **deploy-dev:** symlink (fast iteration)
- **deploy-prod:** copy (release-like, what we consider “migrated”)

A plugin migration is not considered complete until it ends in **deploy-prod**.

---

## The pattern for making changes

### Rule 0: Prefer plugins/scripts over core changes
When Joshua wants a new capability, the default decision tree is:

1) **Plugin-only** (best)
   - add a plugin or extend an existing one
   - verify with `openclaw plugins list` + `openclaw doctor`

2) **Plugin + script workaround** (acceptable)
   - use a script when platform constraints make plugins awkward
   - scripts should still be versioned and reproducible

3) **Minimal core seam** (only if blocked)
   - add the smallest possible “hook point” or “exported helper” in core
   - the seam should be obviously safe and default-off
   - avoid spreading changes across the codebase

### Rule 1: Core changes must be small and localized
If core needs to change, we aim for:

- **single-file** or near-single-file changes
- config-gated behavior
- additive APIs over breaking changes

The goal is to keep upstream merges realistic.

### Rule 2: Every plugin migration has gates
For a plugin to be considered migrated, it must pass:

- `pnpm verify:plugin <pluginId>` (artifact/layout correctness)
- `pnpm verify:doctor-plugin <pluginId>` (no doctor warnings for that plugin)
- runtime verification:
  - `openclaw plugins list | rg <pluginId>` shows it loaded from `~/.openclaw/extensions/<pluginId>/...`

---

## Where to put things

- Long-lived fork docs: **root-level** docs like this file + `docs/`
- Work-in-progress plans: `planning/polytropos/`
- Plugins: **do not** land in this repo; they live in `polytropos-plugins`

---

## Current planning status

See:

- `planning/polytropos/ROADMAP.md`
- `planning/polytropos/PLUGIN-CONTRACT.md`

M0/M2 are complete (plugin pipeline + migration workflow). Next major milestone is **M1: fork skeleton** (core seams + minimal namespace / structure for Polytropos-specific behavior).
