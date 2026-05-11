# Polytropos Core Releases (Single-Gateway Strategy)

This document defines the **release** mechanism for Polytropos core (openclaw-polytropos): how we build, install, and switch runnable `dist/` release directories on a single machine **without** running a parallel dev gateway.

## Terms

- **Release**: creating a versioned runnable directory under `~/polytropos/releases/<tag>/` and (optionally) switching `current`.
- **Update**: merging a newer upstream OpenClaw tag into our fork, then performing the standard **release** procedure (see [`docs/polytropos/UPDATE-PROCEDURE.md`](./UPDATE-PROCEDURE.md)).

## Goal

- One gateway process (the real one).
- Switch core versions by updating a symlink (fast rollback).
- Keep systemd unit stable (no repeated service file edits).

## Assumption (critical)

> **For OpenClaw specifically: a release is a byte-for-byte copy of the installed package’s `dist/` directory.**

Rationale: the gateway is started by executing `dist/index.js`, and that file imports/reads other files within `dist/` at runtime. The safest release artifact is therefore a complete copy of `dist/`.

## Directory layout

We standardize on a single top-level directory:

- `~/polytropos/`

Inside it:

- `~/polytropos/releases/`
  - `~/polytropos/releases/<version>/` — a **release directory**, equivalent to `dist/`
  - `~/polytropos/releases/dev` — symlink to `~/polytropos/openclaw-polytropos/dist` (the core repo build output)
  - `~/polytropos/releases/current` — symlink to the release currently running (typically a versioned release, sometimes `dev`)

Optional:

- `~/polytropos/worktrees/` — optional git worktrees for core development (only if needed)

Note: the default dev target is the main core checkout at `~/polytropos/openclaw-polytropos/`.

## What a "release" contains

A release directory **is the `dist/` tree**. At minimum it must include:

- `index.js` (the gateway entrypoint)
- every file imported (transitively) by `index.js`
- any non-JS runtime assets that are copied into `dist/` by the build (templates, metadata, bundles)

Practically: copy the entire `dist/` directory from the installed package or from a fork build.

## systemd integration (one-time change)

The gateway unit should always execute the entrypoint under `current`:

- `ExecStart=/usr/bin/node /home/ec2-user/polytropos/releases/current/index.js gateway --port 18789`

After this one-time change, switching versions does **not** require editing systemd again.

## Switching versions

Switching is done by updating the `current` symlink atomically:

```bash
ln -sfn ~/polytropos/releases/<version> ~/polytropos/releases/current
systemctl --user restart openclaw-gateway
```

Rollback is the same operation, pointing `current` back to the prior release.

## Creating a versioned release

Policy: a new release directory should only be created from a **versioned tag** in the core repo.

High level:

1) Check out the tag.
2) Build the fork to produce `dist/`.
3) Copy `dist/` into `~/polytropos/releases/<tag>/`.
4) Optionally switch `current` to that version and restart.

## Dev mode (without a second gateway)

Dev mode is simply:

- `~/polytropos/releases/dev` points at a worktree’s `dist/` output.
- `~/polytropos/releases/current` points at `dev`.

You still run only one gateway; you’re just pointing it at a different `dist/` tree.

---

## Notes / guardrails

- Plugins remain deployed separately under `~/.openclaw/extensions/<pluginId>`.
- Core switching changes only the gateway runtime code, not the config file.
- Avoid watch-mode gateways. Rebuild the worktree `dist/` and restart when needed.
