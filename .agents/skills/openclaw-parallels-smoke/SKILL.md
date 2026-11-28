---
name: openclaw-parallels-smoke
description: Prepare, snapshot, run, rerun, debug, or interpret OpenClaw Parallels guest install, onboarding, gateway smoke, and upgrade checks across macOS, Windows, and Linux.
---

# OpenClaw Parallels Smoke

Use this skill for Parallels guest workflows and smoke interpretation. Do not load it for normal repo work.

## Global rules

- Parallels is postpublish-confidence coverage by default, not a prerequisite
  for the bounded beta-publish phase. Run it against one exact published
  package version and record the Validation SHA + Tooling SHA run tuple that
  authorized that package. Validation SHA maps to its Code SHA or Release SHA;
  it is not a third release identity.
- A failed postpublish Parallels lane does not retroactively unpublish a beta.
  Classify it as product, harness/tooling/provenance, infrastructure/credential,
  or wrapper failure. Only a confirmed product defect enters the next beta.
- Use one coordinator and one lane per independent guest family. Diagnose and
  retry one failed family once, then reassess; do not restart the aggregate
  matrix automatically.
- Inventory existing VMs and snapshots before provisioning anything. When a preconfigured pristine
  snapshot matches the requested baseline, switch to it and reuse its user, tools, and base setup.
  Do not create a new VM, reinstall macOS, or rebuild the guest baseline for a "fresh" run.
- "Fresh" means restoring the closest existing pristine snapshot, not creating another snapshot.
  Do not create ad-hoc snapshots unless the user explicitly asks or no suitable baseline exists;
  restore the original snapshot and leave the guest stopped after an ad-hoc run.
- Inspect the snapshot state before restoring it. A pristine `poweron` snapshot can contain the
  preconfigured logged-in session; switch to it normally so Parallels resumes that session. Do not
  pass `--skip-resume` at test entry unless the run intentionally needs to discard the saved session
  and boot from the login window. `--skip-resume` is acceptable for final cleanup that must leave the
  restored source guest stopped.
- Gateway verification in smoke runs should use `openclaw gateway status --deep --require-rpc` unless the stable version being checked does not support it yet.
- Stable `2026.3.12` pre-upgrade diagnostics may require a plain `gateway status --deep` fallback.
- Treat `precheck=latest-ref-fail` on that stable pre-upgrade lane as baseline, not automatically a regression.
- Pass `--json` for machine-readable summaries.
- Per-phase logs land under `.artifacts/parallels/openclaw-parallels-*` by default. Override with `OPENCLAW_PARALLELS_ARTIFACT_ROOT` when a run needs another artifact volume.
- Do not run local and gateway agent turns in parallel on the same fresh workspace or session.
- Hard-cap every top-level Parallels lane with host `timeout --foreground` (or `gtimeout --foreground` if that is the available binary) so a stalled install, snapshot switch, or `prlctl exec` transport cannot consume the rest of the testing window. Defaults:
  - macOS: `75m`
  - Linux: `75m`
  - Windows: `90m`
  - aggregate npm-update wrapper: `150m`
    If a lane hits the cap, stop there, inspect the newest `/tmp/openclaw-parallels-*` run directory and phase log, then fix or rerun the smallest affected lane. Do not keep waiting on a capped lane.
- Actual OpenClaw npm install/update phases are a stricter signal than whole-lane caps: install phases should normally finish within 7 minutes, and update phases should normally show meaningful progress within 5 minutes. If a phase named `install-main`, `install-latest`, `install-baseline`, or `install-baseline-package` exceeds 420s, or a phase named `update-dev` / same-guest `openclaw update` exceeds 300s without new markers, start diagnosis from that phase log and guest process state. Current Windows update phases can still pass after roughly 10-15 minutes because `doctor --fix` may install bundled plugin runtime deps; keep the script hard cap near 20 minutes unless the log is truly stale.
- For a full OS matrix, prefer running independent guest-family lanes in parallel when host capacity allows:
  - `timeout --foreground 75m pnpm test:parallels:macos -- --json`
  - `timeout --foreground 90m pnpm test:parallels:windows -- --json`
  - `timeout --foreground 75m pnpm test:parallels:linux -- --json`
    Keep each lane in its own shell/session and track the run directory for each one. Before starting the matrix, run any required host build/package gate to completion. When current-main tgz packaging is needed, the smoke scripts hold a shared package lock through `pnpm build`, inventory/staging, and `npm pack`; if that lock is missing or broken, serialize the matrix instead of accepting concurrent `dist` mutation.
- Do not run multiple smoke lanes against the same guest family at once. Tahoe lanes share the host HTTP port, and Windows/Linux lanes can collide on snapshot restore/start state if two jobs touch the same VM concurrently.
- Do not run the aggregate `pnpm test:parallels:npm-update` wrapper in parallel with individual macOS/Windows/Linux smoke lanes; it touches the same guest families and snapshots.
- Do not start Parallels lanes while any unrelated host command may rebuild, clean, or restage `dist` (`pnpm build`, `pnpm ui:build`, `pnpm release:check`, `pnpm test:install:smoke`, npm pack/install smoke, or Docker lanes that run package/build prep). Run unrelated build/package gates first, let them finish, then start the VM matrix. Concurrent `dist` mutation can make host `npm pack` fail with missing files and wastes a full VM cycle.
- While running or optimizing the matrix, record wall-clock duration per lane and the slowest phase from `/tmp/openclaw-parallels-*` logs. Use that timing before changing smoke order, timeouts, or helper behavior.
- If a host build changes tracked generated files, stop before spending VM time. Commit the generated artifact separately or fix the generator drift, then rerun the smallest affected lane.
- If `main` is moving under active multi-agent work, prefer a detached worktree pinned to one commit for long Parallels suites. The smoke scripts now verify the packed tgz commit instead of live `git rev-parse HEAD`, but a pinned worktree still avoids noisy rebuild/version drift during reruns.
- For `openclaw update --channel dev` lanes, remember the guest clones GitHub `main`, not your local worktree. If a local fix exists but the rerun still fails inside the cloned dev checkout, do not treat that as disproof of the fix until the branch has been pushed.
- For `prlctl exec`, pass the VM name before `--current-user` (`prlctl exec "$VM" --current-user ...`), not the other way around.
- If the workflow installs OpenClaw from a repo checkout instead of the site installer/npm release, finish by installing a real guest CLI shim and verifying it in a fresh guest shell. `pnpm openclaw ...` inside the repo is not enough for handoff parity.
- On macOS guests, prefer a user-global install plus a stable PATH-visible shim:
  - install with `NPM_CONFIG_PREFIX="$HOME/.npm-global" npm install -g .`
  - make sure `~/.local/bin/openclaw` exists or `~/.npm-global/bin` is on PATH
  - verify from a brand-new guest shell with `which openclaw` and `openclaw --version`

## npm install then update

Read [install and update coverage](references/npm-update.md) in full for every release/update regression run, including single-platform and direct-script runs. Select the guest-family flow below as well.

## CLI invocation footgun

- The Parallels smoke shell scripts should tolerate a literal bare `--` arg so `pnpm test:parallels:* -- --json` and similar forwarded invocations work without needing to call `bash scripts/e2e/...` directly.

## macOS and Windows guest-command transport

Before running or diagnosing a macOS or Windows lane, read [guest-command transport](references/guest-transport.md) in full. Linux uses its own flow below.

## macOS flow

Read [macOS flow](references/macos.md) in full for macOS install, onboarding, dashboard, gateway, or upgrade checks.

## Windows flow

Read [Windows flow](references/windows.md) in full for Windows preparation, snapshots, WSL prerequisites, install, onboarding, gateway, or upgrade checks.

## Linux flow

Read [Linux flow](references/linux.md) in full for Ubuntu guest selection, bootstrap, install, gateway, or upgrade checks.

## Discord roundtrip

- Discord roundtrip is optional and should be enabled with:
  - `--discord-token-env`
  - `--discord-guild-id`
  - `--discord-channel-id`
- After a successful Discord smoke/roundtrip, shut down the guest VM before handoff (`prlctl stop "$VM_NAME"` or the concrete VM name). The macOS smoke harness should do this automatically after successful Discord proof; still stop the VM manually after ad-hoc Discord checks. Do not leave the Discord-configured guest running; it can keep reading/posting in `#maintainer` and spam Discord after the proof is complete.
- Keep the Discord token only in a host env var.
- Use installed `openclaw message send/read`, not `node openclaw.mjs message ...`.
- Set `channels.discord.guilds` as one JSON object, not dotted config paths with snowflakes.
- Avoid long `prlctl enter` or expect-driven Discord config scripts; prefer `prlctl exec --current-user /bin/sh -lc ...` with short commands.
- For a narrower macOS-only Discord proof run, the existing `parallels-discord-roundtrip` skill is the deep-dive companion.
