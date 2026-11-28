# Install and update coverage

## npm install then update

- Preferred entrypoint: `pnpm test:parallels:npm-update`
- For a macOS-only published release update check, use:
  - `timeout --foreground 75m pnpm test:parallels:npm-update -- --platform macos --package-spec openclaw@<old-version> --update-target <target-version-or-tag> --json`
    This keeps the same-guest `openclaw update --tag ...` coverage and uses the shared macOS current-user/sudo fallback without starting Windows/Linux lanes.
- Required coverage: every release/update regression run must include both lanes:
  - fresh snapshot -> install requested package/baseline -> smoke
  - same guest baseline -> run the guest's installed `openclaw update ...` command -> smoke again
- The update lane must exercise OpenClaw's internal updater. Do not count a direct `npm install -g <tgz-or-spec>` or harness-side package swap as update-flow coverage; those are install smokes only.
- For published targets, install the old baseline package first (for example `openclaw@2026.4.9`), then run the installed guest CLI with the intended channel/tag (for example `openclaw update --channel beta --yes --json`) and verify `openclaw --version`, `openclaw update status --json`, gateway RPC, and an agent turn after the command.
- For unpublished targets, pack the candidate on the host, serve the `.tgz` over the harness HTTP server, and point the guest updater at that served package. Prefer `openclaw update --tag http://<host-ip>:<port>/openclaw-<version>.tgz --yes --json`; when channel persistence also matters, pass `--channel <stable|beta>` and set `OPENCLAW_UPDATE_PACKAGE_SPEC` to the same served URL in the guest update environment. The command under test must still be `openclaw update`, not direct npm.
- For unpublished local-fix validation, remember the old baseline updater code still controls the first hop. A fix that lives only in the new updater code cannot change that already-running old process; the served candidate must either keep package/plugin metadata compatible with the baseline host or the baseline itself must include the updater fix.
- For beta/stable verification, resolve the tag immediately before the run (`npm view openclaw@beta version dist.tarball` or `npm view openclaw@latest ...`). Tags can move while a long VM matrix is already running; restart the matrix when the intended prerelease appears after an earlier registry 404/tag-lag check.
- Use the configured secret workflow to inject only the provider keys needed by OpenAI/Anthropic lanes. Do not print secrets or env dumps; pass provider secrets through the guest exec environment.
- Same-guest update verification should set the default model explicitly to `openai/gpt-5.4` before the agent turn and use a fresh explicit `--session-id` so old session model state does not leak into the check.
- The aggregate npm-update wrapper must resolve the Linux VM with the same Ubuntu fallback policy as `parallels-linux-smoke.sh` before both fresh and update lanes. Treat any Ubuntu guest with major version `>= 24` as acceptable when the exact default VM is missing, preferring the newest versioned Ubuntu guest with a fresh poweroff snapshot. On Peter's current host today, use `Ubuntu 26.04`.
- On macOS same-guest update checks, restart the gateway after the npm upgrade before `gateway status` / `agent`; launchd can otherwise report a loaded service while the old process has exited and the fresh process is not RPC-ready yet.
- The npm-update aggregate's macOS update leg writes the guest update script as root, then runs it as the desktop user. If `prlctl exec "$MACOS_VM" --current-user ...` cannot authenticate, retry through plain root `prlctl exec` plus `sudo -u <desktop-user> /usr/bin/env HOME=/Users/<desktop-user> USER=<desktop-user> LOGNAME=<desktop-user> PATH=/opt/homebrew/bin:/opt/homebrew/opt/node/bin:/usr/bin:/bin:/usr/sbin:/sbin ...`. That is a Parallels transport fallback; still verify `openclaw --version`, gateway RPC, and an agent turn after the update.
- On Windows same-guest update checks, restart the gateway after the npm upgrade before `gateway status` / `agent`; in-place global npm updates can otherwise leave stale hashed `dist/*` module imports alive in the running service.
- In those Windows same-guest update checks, do not treat one nonzero `openclaw gateway restart` as definitive failure. Current login-item restarts can report failure before the background service becomes observable again; follow with a longer RPC-ready wait and use `gateway start` only as a recovery step if readiness still never returns.
- After that Windows restart, do not trust one `gateway status --deep --require-rpc` call after a fixed sleep. Retry the RPC-ready probe for roughly 30 seconds and log each attempt; current guests can keep port `18789` bound while the fresh RPC endpoint is still coming up.
- For Windows same-guest update checks, prefer the done-file/log-drain PowerShell runner pattern over one long-lived `prlctl exec ... powershell -EncodedCommand ...` transport. The guest can finish successfully while the outer `prlctl exec` still hangs.
- The Windows same-guest update helper should write stage markers to its log before long steps like tgz download and `npm install -g` so the outer progress monitor does not sit on `waiting for first log line` during healthy but quiet installs.
- Linux same-guest update verification should also export `HOME=/root`, pass `OPENAI_API_KEY` via `prlctl exec ... /usr/bin/env`, and use `openclaw agent --local`; the fresh Linux baseline does not rely on persisted gateway credentials.
- The npm-update wrapper now prints per-lane progress from the nested log files. If a lane still looks stuck, inspect the nested logs in `runDir` first (`macos-fresh.log`, `windows-fresh.log`, `linux-fresh.log`, `macos-update.log`, `windows-update.log`, `linux-update.log`) instead of assuming the outer wrapper hung.
- Each run writes both `summary.json` and `summary.md`; read the markdown first for quick human triage, then the JSON/timings for automation.
- For full beta validation after a tag is published, prefer one command:
  - `timeout --foreground 150m pnpm test:parallels:npm-update -- --beta-validation beta3 --json`
    This resolves `beta3` to the latest `*-beta.3` version, runs latest->that-version same-guest update coverage, and then runs fresh install smoke for that exact published target on the same selected OS matrix. Use `--platform macos|windows|linux` to narrow reruns.
- For beta 4 npm validation with agent turns, the known-good shape is:
  - `gtimeout --foreground 150m pnpm test:parallels:npm-update -- --beta-validation beta4 --model openai/gpt-5.4 --json`
    Prefer the explicit `beta4` alias over `openclaw@beta` when validating a specific prerelease number; npm tags can move.
- If the wrapper fails a lane, read the auto-dumped tail first, then the full nested lane log under `.artifacts/parallels/openclaw-parallels-npm-update.*`.
- Current known macOS update-lane transport signature when the fallback is missing or bypassed: `Unable to authenticate the user. Make sure that the specified credentials are correct and try again.` Treat that as Parallels current-user authentication before blaming npm or OpenClaw.
- A macOS packaged fresh install with global package directories or bundled files mode `0777` usually means the harness used the root `prlctl exec` fallback under a permissive umask. The POSIX guest transports should prepend `umask 022`; verify the phase preflight line before blaming npm.
