# Polytropos Core Releases (Single-Gateway Strategy)

## Purpose

Maintain an **authoritative local release store** of runnable OpenClaw tarballs and switch the single running gateway between them safely.

## Definitions

- **Release (staging):** stage a new version by placing a versioned tarball in `~/polytropos/releases/`, updating `previous.tgz`/`current.tgz`, and installing `current.tgz` globally.
- **Activation:** restart/reload the gateway so the running process begins using the newly-installed global package.

## Release store layout (authoritative)

- `~/polytropos/releases/v<ver>+poly.<N>.tgz` — immutable versioned release tarballs
- `~/polytropos/releases/current.tgz` — symlink to the staged tarball
- `~/polytropos/releases/previous.tgz` — symlink to the rollback tarball

## Correct procedure order

1) **Build** the release tarball in CI (GitHub Actions) from the intended code.
2) **Release (stage)** it on the gateway host (symlinks + global install).
3) **Activate** by restarting/reloading the gateway.

Rollback uses the same order: stage rollback first, then restart/reload.

## Build (CI)

A release tarball is produced by `npm pack` in CI. The output is an npm package tarball (`.tgz`).

Rationale: runtime dependencies are installed via npm when the tarball is installed globally; a raw `dist/` directory is not sufficient.

## Release (stage) procedure (scripted)

Core releases are staged by the release script:

- [`scripts/polytropos-release.mjs`](../../scripts/polytropos-release.mjs)

Usage (tag-driven CI release staging):

```bash
node scripts/polytropos-release.mjs release --tgz /path/to/openclaw-<ver>.tgz
```

What staging does:

- requires the current branch to match `release/YYYY.M.D`
- creates and pushes the next `v<ver>+poly.<N>` tag from that release branch
- waits for the GitHub Actions release workflow triggered by the tag
- downloads the built artifact from Actions
- derives base upstream version `v<ver>` from the nearest reachable tag
- computes next global build number `poly.N` and creates tag `v<ver>+poly.<N>`
- validates the provided tarball (`package/package.json` name/version)
- stages the tarball into `~/polytropos/releases/v<ver>+poly.<N>.tgz`
- updates symlinks **in order**: `previous.tgz` then `current.tgz`
- installs `current.tgz` globally into `/home/ec2-user/.npm-global`
- runs the Polytropos bundled plugin deps helper from the installed package

## Activation

After staging, restart/reload the gateway using the appropriate procedure for your environment.
(Activation is intentionally not automated by the release script.)

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

### Important: releases must be cut from a release branch

The release script refuses to run unless the current branch matches `release/YYYY.M.D`.

Polytropos release work should be performed from a dedicated `origin/release/YYYY.M.D` branch, not `main`.

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
