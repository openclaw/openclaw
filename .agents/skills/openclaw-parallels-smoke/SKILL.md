---
name: openclaw-parallels-smoke
description: End-to-end Parallels smoke, upgrade, and rerun workflow for OpenClaw across macOS, Windows, and Linux guests. Use when Codex needs to run, rerun, debug, or interpret VM-based install, onboarding, gateway smoke tests, latest-release-to-main upgrade checks, fresh snapshot retests, or optional Discord roundtrip verification under Parallels.
---

# OpenClaw Parallels Smoke

Use this skill for Parallels guest workflows and smoke interpretation. Do not load it for normal repo work.

## Global rules

- Use the snapshot most closely matching the requested fresh baseline.
- Gateway verification in smoke runs should use `openclaw gateway status --deep --require-rpc` unless the stable version being checked does not support it yet.
- Stable `2026.3.12` pre-upgrade diagnostics may require a plain `gateway status --deep` fallback.
- Treat `precheck=latest-ref-fail` on that stable pre-upgrade lane as baseline, not automatically a regression.
- Pass `--json` for machine-readable summaries.
- Per-phase logs land under `/tmp/openclaw-parallels-*`.
- Do not run local and gateway agent turns in parallel on the same fresh workspace or session.

## macOS flow

- Preferred entrypoint: `pnpm test:parallels:macos`
- Target the snapshot closest to `macOS 26.3.1 fresh`.
- `prlctl exec` is fine for deterministic repo commands, but use the guest Terminal or `prlctl enter` when installer parity or shell-sensitive behavior matters.
- On the fresh Tahoe snapshot, `brew` exists but `node` may be missing from PATH in noninteractive exec. Use `/opt/homebrew/bin/node` when needed.
- Fresh host-served tgz installs should install as guest root with `HOME=/var/root`, then run onboarding as the desktop user via `prlctl exec --current-user`.
- Root-installed tgz smoke can log plugin blocks for world-writable `extensions/*`; do not treat that as an onboarding or gateway failure unless plugin loading is the task.

## Windows flow

- Preferred entrypoint: `pnpm test:parallels:windows`
- Use the snapshot closest to `pre-openclaw-native-e2e-2026-03-12`.
- Always use `prlctl exec --current-user`; plain `prlctl exec` lands in `NT AUTHORITY\\SYSTEM`.
- Prefer explicit `npm.cmd` and `openclaw.cmd`.
- Use PowerShell only as the transport with `-ExecutionPolicy Bypass`, then call the `.cmd` shims from inside it.
- Keep onboarding and status output ASCII-clean in logs; fancy punctuation becomes mojibake in current capture paths.

## Linux flow

- Preferred entrypoint: `pnpm test:parallels:linux`
- Use the snapshot closest to fresh `Ubuntu 24.04.3 ARM64`.
- Use plain `prlctl exec`; `--current-user` is not the right transport on this snapshot.
- Fresh snapshots may be missing `curl`, and `apt-get update` can fail on clock skew. Bootstrap with `apt-get -o Acquire::Check-Date=false update` and install `curl ca-certificates`.
- Fresh `main` tgz smoke still needs the latest-release installer first because the snapshot has no Node or npm before bootstrap.
- This snapshot does not have a usable `systemd --user` session; managed daemon install is unsupported.
- `prlctl exec` reaps detached Linux child processes on this snapshot, so detached background gateway runs are not trustworthy smoke signals.

## Discord roundtrip

- Discord roundtrip is optional and should be enabled with:
  - `--discord-token-env`
  - `--discord-guild-id`
  - `--discord-channel-id`
- Keep the Discord token only in a host env var.
- Use installed `openclaw message send/read`, not `node openclaw.mjs message ...`.
- Set `channels.discord.guilds` as one JSON object, not dotted config paths with snowflakes.
- Avoid long `prlctl enter` or expect-driven Discord config scripts; prefer `prlctl exec --current-user /bin/sh -lc ...` with short commands.
- For a narrower macOS-only Discord proof run, the existing `parallels-discord-roundtrip` skill is the deep-dive companion.
