---
summary: "Uninstall Clawdbot completely (CLI, service, state, workspace)"
read_when:
  - You want to remove Clawdbot from a machine
  - The gateway service is still running after uninstall
---

# Uninstall

Two paths:
- **Easy path** if `clawdbot` is still installed.
- **Manual service removal** if the CLI is gone but the service is still running.

## Easy path (CLI still installed)

Recommended: use the built-in uninstaller:

```bash
clawdbot uninstall
```

Non-interactive (automation / npx):

```bash
clawdbot uninstall --all --yes --non-interactive
npx -y clawdbot uninstall --all --yes --non-interactive
```

Manual steps (same result):

1) Stop the gateway service:

```bash
clawdbot daemon stop
```

2) Uninstall the gateway service (launchd/systemd/schtasks):

```bash
clawdbot daemon uninstall
```

3) Delete state + config:

```bash
rm -rf "${CLAWDBOT_STATE_DIR:-$HOME/.clawdbot}"
```

If you set `CLAWDBOT_CONFIG_PATH` to a custom location outside the state dir, delete that file too.

4) Delete your workspace (optional, removes agent files):

```bash
rm -rf ~/clawd
```

5) Remove the CLI install (pick the one you used):

```bash
npm rm -g clawdbot
pnpm remove -g clawdbot
bun remove -g clawdbot
```

6) If you installed the macOS app:

```bash
rm -rf /Applications/Clawdbot.app
```

Notes:
- If you used profiles (`--profile` / `CLAWDBOT_PROFILE`), repeat step 3 for each state dir (defaults are `~/.clawdbot-<profile>`).
- In remote mode, the state dir lives on the **gateway host**, so run steps 1-4 there too.

## Manual service removal (CLI not installed)

Use this if the gateway service keeps running but `clawdbot` is missing.

### macOS (launchd)

Default label is `com.clawdbot.gateway` (or `com.clawdbot.<profile>`):

```bash
launchctl bootout gui/$UID/com.clawdbot.gateway
rm -f ~/Library/LaunchAgents/com.clawdbot.gateway.plist
```

If you used a profile, replace the label and plist name with `com.clawdbot.<profile>`.

### Linux (systemd user unit)

Default unit name is `clawdbot-gateway.service` (or `clawdbot-gateway-<profile>.service`):

```bash
systemctl --user disable --now clawdbot-gateway.service
rm -f ~/.config/systemd/user/clawdbot-gateway.service
systemctl --user daemon-reload
```

### Windows (Scheduled Task)

Default task name is `Clawdbot Gateway` (or `Clawdbot Gateway (<profile>)`).
The task script lives under your state dir.

```powershell
schtasks /Delete /F /TN "Clawdbot Gateway"
Remove-Item -Force "$env:USERPROFILE\.clawdbot\gateway.cmd"
```

If you used a profile, delete the matching task name and `~\.clawdbot-<profile>\gateway.cmd`.

## Normal install vs source checkout

### Normal install (install.sh / npm / pnpm / bun)

If you used `https://clawd.bot/install.sh` or `install.ps1`, the CLI was installed with `npm install -g clawdbot@latest`.
Remove it with `npm rm -g clawdbot` (or `pnpm remove -g` / `bun remove -g` if you installed that way).

### Source checkout (git clone)

If you run from a repo checkout (`git clone` + `pnpm clawdbot ...` / `bun run clawdbot ...`):

1) Uninstall the gateway service **before** deleting the repo (use the easy path above or manual service removal).
2) Delete the repo directory.
3) Remove state + workspace as shown above.
