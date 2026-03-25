# Runtime operations

## exe.dev VMs

- Access path: `ssh exe.dev`, then `ssh vm-name`.
- If SSH is flaky, use the exe.dev web terminal or Shelley and keep a tmux session for long work.
- Update OpenClaw with:
  - `sudo npm i -g openclaw@latest`
- Ensure `gateway.mode=local` is set.

## Gateway restart and checks

- Main bot rule: the long-lived LaunchAgent gateway must run from the `main` checkout, not a feature worktree. If a fix lives in a worktree, merge it first, update `main`, and only then restart the gateway from `main`.
- Restart:
  - `pkill -9 -f openclaw-gateway || true`
  - `nohup openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &`
- Verify with:
  - `openclaw channels status --probe`
  - `ss -ltnp | rg 18789`
  - `tail -n 120 /tmp/openclaw-gateway.log`

## Timeout triage gate

- Before debugging a timeout, first prove the expected fix exists on the current branch and build.
- Required 2-minute checks:
  - `git rev-parse --abbrev-ref HEAD`
  - `git log --oneline -1`
  - `rg` for the expected patch signature in the touched files
- If the signature is missing, stop debugging and sync the missing code first.

## macOS gateway behavior

- The gateway is managed by the mac app.
- Restart via the OpenClaw Mac app or `scripts/restart-mac.sh`, not a random tmux process.
- Use `scripts/clawlog.sh` for macOS unified logs.
- The primary bot must run from `main`, not from a worktree build. Use worktrees for development only, then merge to `main`, rebuild, and restart the gateway from `main`.
