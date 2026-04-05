---
summary: "Uninstall Mullusi completely (CLI, service, state, workspace)"
read_when:
  - You want to remove Mullusi from a machine
  - The gateway service is still running after uninstall
title: "Uninstall"
---

# Uninstall

Two paths:

- **Easy path** if `mullusi` is still installed.
- **Manual service removal** if the CLI is gone but the service is still running.

## Easy path (CLI still installed)

Recommended: use the built-in uninstaller:

```bash
mullusi uninstall
```

Non-interactive (automation / npx):

```bash
mullusi uninstall --all --yes --non-interactive
npx -y mullusi uninstall --all --yes --non-interactive
```

Manual steps (same result):

1. Stop the gateway service:

```bash
mullusi gateway stop
```

2. Uninstall the gateway service (launchd/systemd/schtasks):

```bash
mullusi gateway uninstall
```

3. Delete state + config:

```bash
rm -rf "${MULLUSI_STATE_DIR:-$HOME/.mullusi}"
```

If you set `MULLUSI_CONFIG_PATH` to a custom location outside the state dir, delete that file too.

4. Delete your workspace (optional, removes agent files):

```bash
rm -rf ~/.mullusi/workspace
```

5. Remove the CLI install (pick the one you used):

```bash
npm rm -g mullusi
pnpm remove -g mullusi
bun remove -g mullusi
```

6. If you installed the macOS app:

```bash
rm -rf /Applications/Mullusi.app
```

Notes:

- If you used profiles (`--profile` / `MULLUSI_PROFILE`), repeat step 3 for each state dir (defaults are `~/.mullusi-<profile>`).
- In remote mode, the state dir lives on the **gateway host**, so run steps 1-4 there too.

## Manual service removal (CLI not installed)

Use this if the gateway service keeps running but `mullusi` is missing.

### macOS (launchd)

Default label is `ai.mullusi.gateway` (or `ai.mullusi.<profile>`; legacy `com.mullusi.*` may still exist):

```bash
launchctl bootout gui/$UID/ai.mullusi.gateway
rm -f ~/Library/LaunchAgents/ai.mullusi.gateway.plist
```

If you used a profile, replace the label and plist name with `ai.mullusi.<profile>`. Remove any legacy `com.mullusi.*` plists if present.

### Linux (systemd user unit)

Default unit name is `mullusi-gateway.service` (or `mullusi-gateway-<profile>.service`):

```bash
systemctl --user disable --now mullusi-gateway.service
rm -f ~/.config/systemd/user/mullusi-gateway.service
systemctl --user daemon-reload
```

### Windows (Scheduled Task)

Default task name is `Mullusi Gateway` (or `Mullusi Gateway (<profile>)`).
The task script lives under your state dir.

```powershell
schtasks /Delete /F /TN "Mullusi Gateway"
Remove-Item -Force "$env:USERPROFILE\.mullusi\gateway.cmd"
```

If you used a profile, delete the matching task name and `~\.mullusi-<profile>\gateway.cmd`.

## Normal install vs source checkout

### Normal install (install.sh / npm / pnpm / bun)

If you used `https://mullusi.com/install.sh` or `install.ps1`, the CLI was installed with `npm install -g mullusi@latest`.
Remove it with `npm rm -g mullusi` (or `pnpm remove -g` / `bun remove -g` if you installed that way).

### Source checkout (git clone)

If you run from a repo checkout (`git clone` + `mullusi ...` / `bun run mullusi ...`):

1. Uninstall the gateway service **before** deleting the repo (use the easy path above or manual service removal).
2. Delete the repo directory.
3. Remove state + workspace as shown above.
