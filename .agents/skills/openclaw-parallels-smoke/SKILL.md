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
- If `main` is moving under active multi-agent work, prefer a detached worktree pinned to one commit for long Parallels suites. The smoke scripts now verify the packed tgz commit instead of live `git rev-parse HEAD`, but a pinned worktree still avoids noisy rebuild/version drift during reruns.
- For `prlctl exec`, pass the VM name before `--current-user` (`prlctl exec "$VM" --current-user ...`), not the other way around.
- If the workflow installs OpenClaw from a repo checkout instead of the site installer/npm release, finish by installing a real guest CLI shim and verifying it in a fresh guest shell. `pnpm openclaw ...` inside the repo is not enough for handoff parity.
- On macOS guests, prefer a user-global install plus a stable PATH-visible shim:
  - install with `NPM_CONFIG_PREFIX="$HOME/.npm-global" npm install -g .`
  - make sure `~/.local/bin/openclaw` exists or `~/.npm-global/bin` is on PATH
  - verify from a brand-new guest shell with `which openclaw` and `openclaw --version`

## npm install then update

- Preferred entrypoint: `pnpm test:parallels:npm-update`
- Flow: fresh snapshot -> install npm package baseline -> smoke -> install current main tgz on the same guest -> smoke again.
- Same-guest update verification should set the default model explicitly to `openai/gpt-5.4` before the agent turn and use a fresh explicit `--session-id` so old session model state does not leak into the check.
- The aggregate npm-update wrapper must resolve the Linux VM with the same Ubuntu fallback policy as `parallels-linux-smoke.sh` before both fresh and update lanes. Treat any Ubuntu guest with major version `>= 24` as acceptable when the exact default VM is missing, preferring the closest version match. On Peter's current host today, missing `Ubuntu 24.04.3 ARM64` should fall back to `Ubuntu 25.10`.
- On macOS same-guest update checks, restart the gateway after the npm upgrade before `gateway status` / `agent`; launchd can otherwise report a loaded service while the old process has exited and the fresh process is not RPC-ready yet.
- On Windows same-guest update checks, restart the gateway after the npm upgrade before `gateway status` / `agent`; in-place global npm updates can otherwise leave stale hashed `dist/*` module imports alive in the running service.
- For Windows same-guest update checks, prefer the done-file/log-drain PowerShell runner pattern over one long-lived `prlctl exec ... powershell -EncodedCommand ...` transport. The guest can finish successfully while the outer `prlctl exec` still hangs.
- The Windows same-guest update helper should write stage markers to its log before long steps like tgz download and `npm install -g` so the outer progress monitor does not sit on `waiting for first log line` during healthy but quiet installs.
- Linux same-guest update verification should also export `HOME=/root`, pass `OPENAI_API_KEY` via `prlctl exec ... /usr/bin/env`, and use `openclaw agent --local`; the fresh Linux baseline does not rely on persisted gateway credentials.
- The npm-update wrapper now prints per-lane progress from the nested log files. If a lane still looks stuck, inspect the nested logs in `runDir` first (`macos-fresh.log`, `windows-fresh.log`, `linux-fresh.log`, `macos-update.log`, `windows-update.log`, `linux-update.log`) instead of assuming the outer wrapper hung.
- If the wrapper fails a lane, read the auto-dumped tail first, then the full nested lane log under `/tmp/openclaw-parallels-npm-update.*`.

## CLI invocation footgun

- The Parallels smoke shell scripts should tolerate a literal bare `--` arg so `pnpm test:parallels:* -- --json` and similar forwarded invocations work without needing to call `bash scripts/e2e/...` directly.

## macOS flow

- Preferred entrypoint: `pnpm test:parallels:macos`
- Default upgrade coverage on macOS should now include: fresh snapshot -> site installer pinned to the latest stable tag -> `openclaw update --channel dev` on the guest. Treat this as part of the default Tahoe regression plan, not an optional side quest.
- `parallels-macos-smoke.sh --mode upgrade` should run that release-to-dev lane by default. Keep the older host-tgz upgrade path only when the caller explicitly passes `--target-package-spec`.
- Because the default upgrade lane no longer needs a host tgz, skip `npm pack` + host HTTP server startup for `--mode upgrade` unless `--target-package-spec` is set. Keep the pack/server path for `fresh` and `both`.
- If that release-to-dev lane fails with `reason=preflight-no-good-commit` and repeated `sh: pnpm: command not found` tails from `preflight build`, treat it as an updater regression first. The fix belongs in the git/dev updater bootstrap path, not in Parallels retry logic.
- Until the public stable train includes that updater bootstrap fix, the macOS release-to-dev lane may seed a temporary guest-local `pnpm` shim immediately before `openclaw update --channel dev`. Keep that workaround scoped to the smoke harness and remove it once the latest stable no longer needs it.
- In Tahoe `prlctl exec --current-user` runs, prefer explicit `node .../openclaw.mjs ...` invocations for the release->dev handoff itself and for post-update verification. The shebanged global `openclaw` wrapper can fail with `env: node: No such file or directory`, and self-updating through the wrapper is a weaker lane than invoking the entrypoint under a fixed `node`.
- Default to the snapshot closest to `macOS 26.3.1 latest`.
- On Peter's Tahoe VM, `fresh-latest-march-2026` can hang in `prlctl snapshot-switch`; if restore times out there, rerun with `--snapshot-hint 'macOS 26.3.1 latest'` before blaming auth or the harness.
- `parallels-macos-smoke.sh` now retries `snapshot-switch` once after force-stopping a stuck running/suspended guest. If Tahoe still times out after that recovery path, then treat it as a real Parallels/host issue and rerun manually.
- The macOS smoke should include a dashboard load phase after gateway health: resolve the tokenized URL with `openclaw dashboard --no-open`, verify the served HTML contains the Control UI title/root shell, then open Safari and require an established localhost TCP connection from Safari to the gateway port.
- If a packaged install regresses with `500` on `/`, `/healthz`, or `__openclaw/control-ui-config.json` after `fresh.install-main` or `upgrade.install-main`, suspect bundled plugin runtime deps resolving from the package root `node_modules` rather than `dist/extensions/*/node_modules`. Repro quickly with a real `npm pack`/global install lane before blaming dashboard auth or Safari.
- `prlctl exec` is fine for deterministic repo commands, but use the guest Terminal or `prlctl enter` when installer parity or shell-sensitive behavior matters.
- Multi-word `openclaw agent --message ...` checks should go through a guest shell wrapper (`guest_current_user_sh` / `guest_current_user_cli` or `/bin/sh -lc ...`), not raw `prlctl exec ... node openclaw.mjs ...`, or the message can be split into extra argv tokens and Commander reports `too many arguments for 'agent'`.
- When ref-mode onboarding stores `OPENAI_API_KEY` as an env secret ref, the post-onboard agent verification should also export `OPENAI_API_KEY` for the guest command. The gateway can still reject with pairing-required and fall back to embedded execution, and that fallback needs the env-backed credential available in the shell.
- On the fresh Tahoe snapshot, `brew` exists but `node` may be missing from PATH in noninteractive exec. Use `/opt/homebrew/bin/node` when needed.
- Fresh host-served tgz installs should install as guest root with `HOME=/var/root`, then run onboarding as the desktop user via `prlctl exec --current-user`.
- Root-installed tgz smoke can log plugin blocks for world-writable `extensions/*`; do not treat that as an onboarding or gateway failure unless plugin loading is the task.

## Windows flow

- Preferred entrypoint: `pnpm test:parallels:windows`
- Use the snapshot closest to `pre-openclaw-native-e2e-2026-03-12`.
- Default upgrade coverage on Windows should now include: fresh snapshot -> site installer pinned to the requested stable tag -> `openclaw update --channel dev` on the guest. Keep the older host-tgz upgrade path only when the caller explicitly passes `--target-package-spec`.
- Optional exact npm-tag baseline on Windows: `bash scripts/e2e/parallels-windows-smoke.sh --mode upgrade --target-package-spec openclaw@<tag> --json`. That lane installs the published npm tarball as baseline, then runs `openclaw update --channel dev`.
- Optional forward-fix Windows validation: `bash scripts/e2e/parallels-windows-smoke.sh --mode upgrade --upgrade-from-packed-main --json`. That lane installs the packed current-main npm tgz as baseline, then runs `openclaw update --channel dev`.
- Always use `prlctl exec --current-user`; plain `prlctl exec` lands in `NT AUTHORITY\\SYSTEM`.
- Prefer explicit `npm.cmd` and `openclaw.cmd`.
- Use PowerShell only as the transport with `-ExecutionPolicy Bypass`, then call the `.cmd` shims from inside it.
- Current Windows Node installs expose `corepack` as a `.cmd` shim. If a release-to-dev lane sees `corepack` on PATH but `openclaw update --channel dev` still behaves as if corepack is missing, treat that as an exec-shim regression first.
- If an exact published-tag Windows lane fails during preflight with `npm run build` and `'pnpm' is not recognized`, remember that the guest is still executing the old published updater. Validate the fix with `--upgrade-from-packed-main`, then wait for the next tagged npm release before expecting the historical tag lane to pass.
- Multi-word `openclaw agent --message ...` checks should call `& $openclaw ...` inside PowerShell, not `Start-Process ... -ArgumentList` against `openclaw.cmd`, or Commander can see split argv and throw `too many arguments for 'agent'`.
- Windows installer/tgz phases now retry once after guest-ready recheck; keep new Windows smoke steps idempotent so a transport-flake retry is safe.
- If a Windows retry sees the VM become `suspended` or `stopped`, resume/start it before the next `prlctl exec`; otherwise the second attempt just repeats the same `rc=255`.
- Windows global `npm install -g` phases can stay quiet for a minute or more even when healthy; inspect the phase log before calling it hung, and only treat it as a regression once the retry wrapper or timeout trips.
- The Windows baseline-package helpers now auto-dump the latest guest `npm-cache/_logs/*-debug-0.log` tail on timeout or nonzero completion. Read that tail in the phase log before opening a second guest shell.
- Fresh Windows tgz install phases should also use the background PowerShell runner plus done-file/log-drain pattern; do not rely on one long-lived `prlctl exec ... powershell ... npm install -g` transport for package installs.
- Windows release-to-dev helpers should log `where pnpm` before and after the update and require `where pnpm` to succeed post-update. That proves the updater installed or enabled `pnpm` itself instead of depending on a smoke-only bootstrap.
- Fresh Windows ref-mode onboard should use the same background PowerShell runner plus done-file/log-drain pattern as the npm-update helper, including startup materialization checks, host-side timeouts on short poll `prlctl exec` calls, and retry-on-poll-failure behavior for transient transport flakes.
- Fresh Windows daemon-health reachability should use a hello-only gateway probe and a longer per-probe timeout than the default local attach path; full health RPCs are too eager during initial startup on current main.
- Fresh Windows ref-mode agent verification should set `OPENAI_API_KEY` in the PowerShell environment before invoking `openclaw.cmd agent`, for the same pairing-required fallback reason as macOS.
- The standalone Windows upgrade smoke lane should stop the managed gateway after `upgrade.install-main` and before `upgrade.onboard-ref`. Restarting before onboard can leave the old process alive on the pre-onboard token while onboard rewrites `~/.openclaw/openclaw.json`, which then fails `gateway-health` with `unauthorized: gateway token mismatch`.
- If standalone Windows upgrade fails with a gateway token mismatch but `pnpm test:parallels:npm-update` passes, trust the mismatch as a standalone ref-onboard ordering bug first; the npm-update helper does not re-run ref-mode onboard on the same guest.
- Keep onboarding and status output ASCII-clean in logs; fancy punctuation becomes mojibake in current capture paths.
- If you hit an older run with `rc=255` plus an empty `fresh.install-main.log` or `upgrade.install-main.log`, treat it as a likely `prlctl exec` transport drop after guest start-up, not immediate proof of an npm/package failure.

## Linux flow

- Preferred entrypoint: `pnpm test:parallels:linux`
- Use the snapshot closest to fresh `Ubuntu 24.04.3 ARM64`.
- If that exact VM is missing on the host, any Ubuntu guest with major version `>= 24` is acceptable; prefer the closest versioned Ubuntu guest with a fresh poweroff snapshot. On Peter's host today, that is `Ubuntu 25.10`.
- Use plain `prlctl exec`; `--current-user` is not the right transport on this snapshot.
- Fresh snapshots may be missing `curl`, and `apt-get update` can fail on clock skew. Bootstrap with `apt-get -o Acquire::Check-Date=false update` and install `curl ca-certificates`.
- Fresh `main` tgz smoke still needs the latest-release installer first because the snapshot has no Node or npm before bootstrap.
- This snapshot does not have a usable `systemd --user` session; managed daemon install is unsupported.
- The Linux smoke now falls back to a manual `setsid openclaw gateway run --bind loopback --port 18789 --force` launch with `HOME=/root` and the provider secret exported, then verifies `gateway status --deep --require-rpc` when available.
- The Linux manual gateway launch should wait for `gateway status --deep --require-rpc` inside the `gateway-start` phase; otherwise the first status probe can race the background bind and fail a healthy lane.
- If Linux gateway bring-up fails, inspect `/tmp/openclaw-parallels-linux-gateway.log` in the guest phase logs first; the common failure mode is a missing provider secret in the launched gateway environment.

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
