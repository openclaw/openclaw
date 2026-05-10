# Polytropos (OpenClaw fork)

Polytropos is a fork of **OpenClaw** focused on one thing: **making feature work cheap**.

OpenClaw already has a powerful plugin system; the problem we kept hitting in practice was that “quick additions” often turn into a pile of ad‑hoc patches, scripts, and one-off deployments. Polytropos formalizes a workflow where:

- most changes live in **plugins** (fast iteration, low risk)
- when core changes are needed, they are **tiny, explicit seams** (mergeable, reviewable)

This repository is the *core fork* (the runtime + loader). Plugins live in a separate repo (see below).

---

## Repos

- **Core fork:** `openclaw-polytropos` (this repo)
- **Plugins monorepo:** [`polytropos-plugins`](https://github.com/JoshuaCWebDeveloper/polytropos-plugins)

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
   - document any new events/hooks in `docs/polytropos/POLYTROPOS-EVENTS.md`
3) Verify in runtime.

---

## Where to put things

- Long-lived fork docs: `docs/polytropos/` (with this overview kept at repo root)
- Work-in-progress plans: `planning/polytropos/`
- Plugins: **do not** land in this repo; they live in `polytropos-plugins`

---

## Current planning status

See:

- `planning/polytropos/ROADMAP.md`
- `planning/polytropos/PLUGIN-CONTRACT.md`

M0/M2 are complete (plugin pipeline + migration workflow). Next major milestone is **M1: fork skeleton** (core seams + minimal namespace / structure for Polytropos-specific behavior).
