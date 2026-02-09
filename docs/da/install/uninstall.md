---
summary: "Afinstallér OpenClaw fuldstændigt (CLI, service, tilstand, arbejdsområde)"
read_when:
  - Du vil fjerne OpenClaw fra en maskine
  - Gateway-servicen kører stadig efter afinstallation
title: "Afinstallér"
---

# Afinstallér

To veje:

- **Nem vej** hvis `openclaw` stadig er installeret.
- **Manuel fjernelse af service** hvis CLI’en er væk, men servicen stadig kører.

## Nem vej (CLI stadig installeret)

Anbefalet: brug den indbyggede afinstaller:

```bash
openclaw uninstall
```

Ikke-interaktiv (automatisering / npx):

```bash
openclaw uninstall --all --yes --non-interactive
npx -y openclaw uninstall --all --yes --non-interactive
```

Manuelle trin (samme resultat):

1. Stop gateway-servicen:

```bash
openclaw gateway stop
```

2. Afinstallér gateway-servicen (launchd/systemd/schtasks):

```bash
openclaw gateway uninstall
```

3. Slet tilstand + konfiguration:

```bash
rm -rf "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
```

Hvis du har sat `OPENCLAW_CONFIG_PATH` til en brugerdefineret placering uden for tilstandsmappen, så slet også den fil.

4. Slet dit arbejdsområde (valgfrit, fjerner agentfiler):

```bash
rm -rf ~/.openclaw/workspace
```

5. Fjern CLI-installationen (vælg den metode, du brugte):

```bash
npm rm -g openclaw
pnpm remove -g openclaw
bun remove -g openclaw
```

6. Hvis du installerede macOS-appen:

```bash
rm -rf /Applications/OpenClaw.app
```

Noter:

- Hvis du brugte profiler (`--profile` / `OPENCLAW_PROFILE`), gentag trin 3 for hver tilstandsmappen (standarder er `~/.openclaw-<profile>`).
- I fjern-tilstand ligger tilstandsmappen på **gateway-værten**, så kør også trin 1-4 dér.

## Manuel fjernelse af service (CLI ikke installeret)

Brug dette, hvis gateway-servicen bliver ved med at køre, men `openclaw` mangler.

### macOS (launchd)

Standard etiket er `bot.molt.gateway` (eller `bot.molt.<profile>`; arv `com.openclaw.*` kan stadig eksistere):

```bash
launchctl bootout gui/$UID/bot.molt.gateway
rm -f ~/Library/LaunchAgents/bot.molt.gateway.plist
```

Hvis du har brugt en profil, skal du erstatte etiketten og plist navn med `bot.molt.<profile>`. Fjern enhver arv `com.openclaw.*` plists hvis til stede.

### Linux (systemd bruger-enhed)

Standard enhedsnavn er `openclaw-gateway.service` (eller `openclaw-gateway-<profile>.service`):

```bash
systemctl --user disable --now openclaw-gateway.service
rm -f ~/.config/systemd/user/openclaw-gateway.service
systemctl --user daemon-reload
```

### Windows (Planlagt opgave)

Standard opgavenavn er `OpenClaw Gateway` (eller `OpenClaw Gateway (<profile>)`).
Opgaven script lever under din tilstand dir.

```powershell
schtasks /Delete /F /TN "OpenClaw Gateway"
Remove-Item -Force "$env:USERPROFILE\.openclaw\gateway.cmd"
```

Hvis du brugte en profil, så slet det tilsvarende opgavenavn og `~\.openclaw-<profile>\gateway.cmd`.

## Normal installation vs. kildekode-checkout

### Normal installation (install.sh / npm / pnpm / bun)

Hvis du brugte `https://openclaw.ai/install.sh` eller `install.ps1`, blev CLI installeret med `npm install -g openclaw@latest`.
Fjern det med `npm rm -g openclaw` (eller `pnpm remove -g` / `bun remove -g` hvis du installerede på den måde).

### Kildekode-checkout (git clone)

Hvis du kører fra et repo-checkout (`git clone` + `openclaw ...` / `bun run openclaw ...`):

1. Afinstallér gateway-servicen **før** du sletter repoet (brug den nemme vej ovenfor eller manuel fjernelse af service).
2. Slet repo-mappen.
3. Fjern tilstand + arbejdsområde som vist ovenfor.
