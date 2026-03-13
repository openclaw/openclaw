## macOS LaunchAgent restart investigation

### Problem summary

Issue #45178 tracks a macOS LaunchAgent dropout that can happen after a config-triggered gateway restart or reload.

The suspected path is:

- `src/cli/gateway-cli/run-loop.ts`
- `src/infra/process-respawn.ts`
- `src/daemon/launchd-restart-handoff.ts`

In this path, the launchd-supervised gateway exits and relies on `KeepAlive=true` to come back under launchd control.

### Current hypothesis

The current detached handoff for `start-after-exit` assumes launchd will either reload the job quickly or that a direct `launchctl start` is enough to recover. If launchd has not reloaded the service target yet, that assumption may be too optimistic and can leave the LaunchAgent missing from launchd after the old process exits.

This note also preserves an important constraint from the earlier fix recorded in `CHANGELOG.md` for #39760 / #39763: do not restore a self-issued `launchctl kickstart -k` as the primary restart path. That earlier change removed it because it raced with launchd bootout and could permanently unload the LaunchAgent.

### What this patch changes

This patch keeps the intended `exit(0) + KeepAlive` restart behavior as the first choice.

For `start-after-exit` only, the detached handoff now:

- waits for the old PID to exit,
- retries `launchctl print <service-target>` for a short window to see whether launchd reloaded the service on its own,
- exits without further action if the service becomes visible again,
- otherwise runs a conservative repair sequence:
  - `launchctl enable <service-target>`
  - `launchctl bootstrap <domain> <plist-path>`
  - `launchctl start <service-target>` with `kickstart -k` only as the final fallback

The retry window is intentionally modest: 15 attempts with `0.2s` sleeps, or about 3 seconds total. The goal is to give launchd a short chance to recover on its own before trying repair commands.

### How to test on a second macOS machine

1. Install or update the branch on a separate macOS machine that reproduces or is likely to reproduce #45178.
2. Ensure the gateway is running under the app-bundled LaunchAgent, not an ad hoc terminal session.
3. Capture the initial state:
   - `launchctl print gui/$UID/ai.openclaw.gateway`
   - `openclaw channels status --probe`
4. Trigger the config-driven restart or reload flow that previously caused the dropout.
5. Immediately watch for whether the LaunchAgent stays loaded:
   - `while true; do launchctl print gui/$UID/ai.openclaw.gateway >/tmp/openclaw-launchd-print.log 2>&1; echo $?; sleep 0.2; done`
   - or use repeated `launchctl print` manually if you want less noise.
6. Confirm the gateway becomes healthy again:
   - `openclaw channels status --probe`
   - `tail -n 120 ~/.openclaw/logs/gateway.log`
7. If the dropout still happens, collect:
   - unified logs around the restart,
   - the `launchctl print` output before and after,
   - whether the recovery path reloaded the plist and restored the service.

### Caveat

This is a candidate fix, not a proven fix. It hardens one plausible failure mode in the detached launchd restart handoff, but it does not prove that the root cause of #45178 is fully understood yet.
