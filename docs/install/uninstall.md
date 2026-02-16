---
summary: "Uninstall SmartAgentNeo completely (CLI, service, state, workspace)"
read_when:
  - You want to remove SmartAgentNeo from a machine
  - The gateway service is still running after uninstall
title: "Uninstall"
---

# Uninstall

Two paths:

- **Easy path** if `smart-agent-neo` is still installed.
- **Manual service removal** if the CLI is gone but the service is still running.

## Easy path (CLI still installed)

Recommended: use the built-in uninstaller:

```bash
smart-agent-neo uninstall
```

Non-interactive (automation / npx):

```bash
smart-agent-neo uninstall --all --yes --non-interactive
npx -y smart-agent-neo uninstall --all --yes --non-interactive
```

Manual steps (same result):

1. Stop the gateway service:

```bash
smart-agent-neo gateway stop
```

2. Uninstall the gateway service (launchd/systemd/schtasks):

```bash
smart-agent-neo gateway uninstall
```

3. Delete state + config:

```bash
rm -rf "${SMART_AGENT_NEO_STATE_DIR:-$HOME/.smart-agent-neo}"
```

If you set `SMART_AGENT_NEO_CONFIG_PATH` to a custom location outside the state dir, delete that file too.

4. Delete your workspace (optional, removes agent files):

```bash
rm -rf ~/.smart-agent-neo/workspace
```

5. Remove the CLI install (pick the one you used):

```bash
npm rm -g smart-agent-neo
pnpm remove -g smart-agent-neo
bun remove -g smart-agent-neo
```

6. If you installed the macOS app:

```bash
rm -rf /Applications/SmartAgentNeo.app
```

Notes:

- If you used profiles (`--profile` / `SMART_AGENT_NEO_PROFILE`), repeat step 3 for each state dir (defaults are `~/.smart-agent-neo-<profile>`).
- In remote mode, the state dir lives on the **gateway host**, so run steps 1-4 there too.

## Manual service removal (CLI not installed)

Use this if the gateway service keeps running but `smart-agent-neo` is missing.

### macOS (launchd)

Default label is `bot.molt.gateway` (or `bot.molt.<profile>`; legacy `com.smart-agent-neo.*` may still exist):

```bash
launchctl bootout gui/$UID/bot.molt.gateway
rm -f ~/Library/LaunchAgents/bot.molt.gateway.plist
```

If you used a profile, replace the label and plist name with `bot.molt.<profile>`. Remove any legacy `com.smart-agent-neo.*` plists if present.

### Linux (systemd user unit)

Default unit name is `smart-agent-neo-gateway.service` (or `smart-agent-neo-gateway-<profile>.service`):

```bash
systemctl --user disable --now smart-agent-neo-gateway.service
rm -f ~/.config/systemd/user/smart-agent-neo-gateway.service
systemctl --user daemon-reload
```

### Windows (Scheduled Task)

Default task name is `SmartAgentNeo Gateway` (or `SmartAgentNeo Gateway (<profile>)`).
The task script lives under your state dir.

```powershell
schtasks /Delete /F /TN "SmartAgentNeo Gateway"
Remove-Item -Force "$env:USERPROFILE\.smart-agent-neo\gateway.cmd"
```

If you used a profile, delete the matching task name and `~\.smart-agent-neo-<profile>\gateway.cmd`.

## Normal install vs source checkout

### Normal install (install.sh / npm / pnpm / bun)

If you used `https://smart-agent-neo.ai/install.sh` or `install.ps1`, the CLI was installed with `npm install -g smart-agent-neo@latest`.
Remove it with `npm rm -g smart-agent-neo` (or `pnpm remove -g` / `bun remove -g` if you installed that way).

### Source checkout (git clone)

If you run from a repo checkout (`git clone` + `smart-agent-neo ...` / `bun run smart-agent-neo ...`):

1. Uninstall the gateway service **before** deleting the repo (use the easy path above or manual service removal).
2. Delete the repo directory.
3. Remove state + workspace as shown above.
