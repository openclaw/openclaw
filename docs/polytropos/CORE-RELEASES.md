# Polytropos Core Releases (Single-Gateway Strategy)

This document defines the **release** mechanism for Polytropos core (openclaw-polytropos): how we build, install, and switch runnable **release tarballs** (`.tgz`) on a single machine **without** running a parallel dev gateway.

## Terms

- **Release (staging)**: producing a versioned `.tgz` under `~/polytropos/releases/`, switching `current.tgz`/`previous.tgz`, and installing `current.tgz` globally. A release stages new bits but does **not** change what the running gateway process is currently executing.
- **Activation**: applying a staged release to the running gateway by restarting/reloading it using the appropriate procedure for your runtime context (service manager, container/orchestrator, supervisor, etc.).
- **Update**: merging a newer upstream OpenClaw tag into our fork, then performing the standard **release** procedure (see [`docs/polytropos/UPDATE-PROCEDURE.md`](./UPDATE-PROCEDURE.md)).

## Goal

- One gateway process (the real one).
- Switch core versions by updating a symlink (fast rollback).

## Assumption (critical)

> **For OpenClaw specifically: a core release is an npm package tarball produced by `npm pack` (a `.tgz`).**

Rationale: OpenClaw runtime depends on third-party dependencies resolved via `node_modules`. A `dist/`-only directory is not runnable because it does not include the dependency tree. Installing the `.tgz` via npm ensures dependencies are installed and runtime resolution matches how the gateway runs today.

## Directory layout

We standardize on a single top-level directory:

- `~/polytropos/`

Inside it:

- `~/polytropos/releases/`
  - `~/polytropos/releases/v<ver>+poly.<N>.tgz` — versioned release tarballs (output of `npm pack`)  
    (tag format matches the filename)
  - `~/polytropos/releases/current.tgz` — symlink to the tarball we want installed
  - `~/polytropos/releases/previous.tgz` — symlink to the prior tarball (rollback)

We keep the gateway systemd unit unchanged (it continues to run the globally installed `openclaw` package).

## What a "release" contains

A release is a `.tgz` produced by `npm pack` from this repo.

It contains a subset of the repo as defined by `package.json.files`, including `dist/` and bundled assets. Dependencies are installed by npm when the tarball is installed globally.

## Switching versions

Switching is done by:

1. updating symlinks:
   - `previous.tgz` → old `current.tgz`
   - `current.tgz` → new `<tag>.tgz`
2. installing the tarball globally into the prefix the service uses (`/home/ec2-user/.npm-global`)
3. running the Polytropos bundled plugin deps helper from the installed package (ensures bundled plugin runtime deps exist)

Rollback is the same operation, pointing `current.tgz` back to `previous.tgz`.

## Activation (restart/reload)

Activation is a separate step from release.

1. Complete the **release** procedure first (the new `.tgz` is built, `current.tgz` is updated, and the package is installed globally).
2. Then **activate** the staged release by restarting/reloading the gateway using the appropriate procedure for your environment (for example: your service manager, container/orchestrator, or supervisor).

## Release procedure (scripted)

Core releases are performed by the release script:

- [`scripts/polytropos-release.mjs`](../../scripts/polytropos-release.mjs)

Usage:

```bash
node scripts/polytropos-release.mjs release
```

What it does (high level):

- finds the nearest reachable release tag (`v<ver>` or `v<ver>+poly.<N>`) and derives the base upstream version `v<ver>` from it
- computes next global build number `poly.N` (always increments)
- creates tag `v<ver>+poly.<N>`
- builds prepared artifacts (`pnpm install`, `pnpm build`, `pnpm ui:build` via the pack workflow)
- runs `npm pack` to produce `v<ver>+poly.<N>.tgz`
- updates symlinks (mandatory): `previous.tgz` then `current.tgz`
- installs `current.tgz` globally into `/home/ec2-user/.npm-global`
- runs the Polytropos bundled plugin deps helper from the installed package (`scripts/polytropos-bundled-plugin-deps-helper.mjs`); it self-discovers the installed package root and ensures bundled plugin runtime deps are present
- does not restart/activate the gateway (activation is a separate manual step)

## Dev mode (without a second gateway)

Dev mode uses `npm link` so the **globally installed** `openclaw` package resolves to your working tree checkout.

High level:

1. In the fork repo:

```bash
cd ~/polytropos/openclaw-polytropos
pnpm install
pnpm build
pnpm ui:build
npm link
```

2. Link the global package name to that checkout:

```bash
npm link openclaw
```

After this, the systemd unit continues to run the same ExecStart, but the underlying `openclaw` install points at the dev checkout.

To exit dev mode, reinstall a released tarball (see release procedure above).

---

## Notes / guardrails

### Release directory invariants (DO NOT VIOLATE)

- `~/polytropos/releases/` is an **authoritative store** of runnable releases.
- Versioned files `v<ver>+poly.<N>.tgz` are **immutable** once created. Never overwrite them.
- `current.tgz` and `previous.tgz` are **symlinks** to versioned tarballs.

**Critical footgun:** do **not** use `cp` to write to `current.tgz` or `previous.tgz`.

- `cp some.tgz current.tgz` will **follow the symlink** and overwrite the target versioned file.
- This silently corrupts the release store (filenames no longer match contents) and can destroy rollback.

If you must copy for any reason, use symlink-safe semantics (e.g. `cp -P` / `--no-dereference`) and still prefer the scripted procedure.

### Required verification

Before updating symlinks or installing anything globally, verify:

- Each `v<ver>+poly.<N>.tgz` contains `package/package.json` with `version == <ver>`.
- `current.tgz` points at the intended versioned tarball.

### Activation safety

Activation (restart/reload) must use the **proper gateway procedure/tooling** for the environment.
Do not improvise restarts.

---

- Plugins remain deployed separately under `~/.openclaw/extensions/<pluginId>`.
- Core switching changes only the gateway runtime code, not the config file.
- Avoid watch-mode gateways. Rebuild the worktree `dist/` and restart when needed.
