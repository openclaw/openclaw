---
summary: "Ganap na i-uninstall ang OpenClaw (CLI, service, state, workspace)"
read_when:
  - Gusto mong alisin ang OpenClaw mula sa isang makina
  - Patuloy na tumatakbo ang gateway service kahit pagkatapos ng uninstall
title: "I-uninstall"
x-i18n:
  source_path: install/uninstall.md
  source_hash: 6673a755c5e1f90a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:39Z
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

Ang default na label ay `bot.molt.gateway` (o `bot.molt.<profile>`; maaaring umiiral pa ang legacy na `com.openclaw.*`):

```bash
launchctl bootout gui/$UID/bot.molt.gateway
rm -f ~/Library/LaunchAgents/bot.molt.gateway.plist
```

Kung gumamit ka ng profile, palitan ang label at pangalan ng plist ng `bot.molt.<profile>`. Alisin ang anumang legacy na `com.openclaw.*` plists kung mayroon.

### Linux (systemd user unit)

Ang default na unit name ay `openclaw-gateway.service` (o `openclaw-gateway-<profile>.service`):

```bash
systemctl --user disable --now openclaw-gateway.service
rm -f ~/.config/systemd/user/openclaw-gateway.service
systemctl --user daemon-reload
```

### Windows (Scheduled Task)

Ang default na task name ay `OpenClaw Gateway` (o `OpenClaw Gateway (<profile>)`).
Ang task script ay nasa ilalim ng iyong state dir.

```powershell
schtasks /Delete /F /TN "OpenClaw Gateway"
Remove-Item -Force "$env:USERPROFILE\.openclaw\gateway.cmd"
```

Kung gumamit ka ng profile, burahin ang katugmang task name at `~\.openclaw-<profile>\gateway.cmd`.

## Normal na install vs source checkout

### Normal na install (install.sh / npm / pnpm / bun)

Kung gumamit ka ng `https://openclaw.ai/install.sh` o `install.ps1`, ang CLI ay na-install gamit ang `npm install -g openclaw@latest`.
Alisin ito gamit ang `npm rm -g openclaw` (o `pnpm remove -g` / `bun remove -g` kung ganoon ang paraan ng pag-install mo).

### Source checkout (git clone)

Kung tumatakbo ka mula sa repo checkout (`git clone` + `openclaw ...` / `bun run openclaw ...`):

1. I-uninstall ang gateway service **bago** burahin ang repo (gamitin ang madaling ruta sa itaas o manwal na pag-alis ng service).
2. Burahin ang repo directory.
3. Alisin ang state + workspace gaya ng ipinakita sa itaas.
