---
summary: "Ganap na i-uninstall ang OpenClaw (CLI, service, state, workspace)"
read_when:
  - Gusto mong alisin ang OpenClaw mula sa isang makina
  - Patuloy na tumatakbo ang gateway service kahit pagkatapos ng uninstall
title: "I-uninstall"
---

# I-uninstall

Dalawang ruta:

- **Madaling ruta** kung naka-install pa rin ang `openclaw`.
- **Manwal na pag-alis ng service** kung wala na ang CLI pero tumatakbo pa rin ang service.

## Madaling ruta (naka-install pa rin ang CLI)

Inirerekomenda: gamitin ang built-in na uninstaller:

```bash
openclaw uninstall
```

Non-interactive (automation / npx):

```bash
openclaw uninstall --all --yes --non-interactive
npx -y openclaw uninstall --all --yes --non-interactive
```

Manwal na mga hakbang (parehong resulta):

1. Ihinto ang gateway service:

```bash
openclaw gateway stop
```

2. I-uninstall ang gateway service (launchd/systemd/schtasks):

```bash
openclaw gateway uninstall
```

3. Burahin ang state + config:

```bash
rm -rf "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
```

Kung itinakda mo ang `OPENCLAW_CONFIG_PATH` sa isang custom na lokasyon sa labas ng state dir, burahin din ang file na iyon.

4. Burahin ang iyong workspace (opsyonal, inaalis ang mga agent file):

```bash
rm -rf ~/.openclaw/workspace
```

5. Alisin ang CLI install (piliin kung alin ang ginamit mo):

```bash
npm rm -g openclaw
pnpm remove -g openclaw
bun remove -g openclaw
```

6. Kung nag-install ka ng macOS app:

```bash
rm -rf /Applications/OpenClaw.app
```

Mga tala:

- Kung gumamit ka ng mga profile (`--profile` / `OPENCLAW_PROFILE`), ulitin ang hakbang 3 para sa bawat state dir (ang mga default ay `~/.openclaw-<profile>`).
- Sa remote mode, ang state dir ay nasa **host ng Gateway**, kaya patakbuhin din ang mga hakbang 1-4 doon.

## Manwal na pag-alis ng service (hindi naka-install ang CLI)

Gamitin ito kung patuloy na tumatakbo ang gateway service pero nawawala ang `openclaw`.

### macOS (launchd)

Ang default na label ay `bot.molt.gateway` (o `bot.molt.<profile>``; legacy `com.openclaw.\*\` may still exist):

```bash
launchctl bootout gui/$UID/bot.molt.gateway
rm -f ~/Library/LaunchAgents/bot.molt.gateway.plist
```

If you used a profile, replace the label and plist name with `bot.molt.<profile>`. Remove any legacy `com.openclaw.*` plists if present.

### Linux (systemd user unit)

Ang default na unit name ay `openclaw-gateway.service` (o `openclaw-gateway-<profile>.service`):

```bash
systemctl --user disable --now openclaw-gateway.service
rm -f ~/.config/systemd/user/openclaw-gateway.service
systemctl --user daemon-reload
```

### Windows (Scheduled Task)

Default task name is `OpenClaw Gateway` (or `OpenClaw Gateway (<profile>)`).
The task script lives under your state dir.

```powershell
schtasks /Delete /F /TN "OpenClaw Gateway"
Remove-Item -Force "$env:USERPROFILE\.openclaw\gateway.cmd"
```

Kung gumamit ka ng profile, burahin ang katugmang task name at `~\.openclaw-<profile>\gateway.cmd`.

## Normal na install vs source checkout

### Normal na install (install.sh / npm / pnpm / bun)

If you used `https://openclaw.ai/install.sh` or `install.ps1`, the CLI was installed with `npm install -g openclaw@latest`.
Remove it with `npm rm -g openclaw` (or `pnpm remove -g` / `bun remove -g` if you installed that way).

### Source checkout (git clone)

Kung tumatakbo ka mula sa repo checkout (`git clone` + `openclaw ...` / `bun run openclaw ...`):

1. I-uninstall ang gateway service **bago** burahin ang repo (gamitin ang madaling ruta sa itaas o manwal na pag-alis ng service).
2. Burahin ang repo directory.
3. Alisin ang state + workspace gaya ng ipinakita sa itaas.
