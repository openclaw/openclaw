---
summary: "OpenClaw volledig verwijderen (CLI, service, status, werkruimte)"
read_when:
  - Je wilt OpenClaw van een machine verwijderen
  - De Gateway-service draait nog steeds na het verwijderen
title: "Verwijderen"
---

# Verwijderen

Twee routes:

- **Eenvoudige route** als `openclaw` nog is geïnstalleerd.
- **Handmatige serviceverwijdering** als de CLI weg is maar de service nog draait.

## Eenvoudige route (CLI nog geïnstalleerd)

Aanbevolen: gebruik de ingebouwde uninstaller:

```bash
openclaw uninstall
```

Niet-interactief (automatisering / npx):

```bash
openclaw uninstall --all --yes --non-interactive
npx -y openclaw uninstall --all --yes --non-interactive
```

Handmatige stappen (hetzelfde resultaat):

1. Stop de Gateway-service:

```bash
openclaw gateway stop
```

2. Verwijder de Gateway-service (launchd/systemd/schtasks):

```bash
openclaw gateway uninstall
```

3. Verwijder status + config:

```bash
rm -rf "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
```

Als je `OPENCLAW_CONFIG_PATH` naar een aangepaste locatie buiten de statusmap hebt ingesteld, verwijder dat bestand ook.

4. Verwijder je werkruimte (optioneel, verwijdert agentbestanden):

```bash
rm -rf ~/.openclaw/workspace
```

5. Verwijder de CLI-installatie (kies degene die je hebt gebruikt):

```bash
npm rm -g openclaw
pnpm remove -g openclaw
bun remove -g openclaw
```

6. Als je de macOS-app hebt geïnstalleerd:

```bash
rm -rf /Applications/OpenClaw.app
```

Notities:

- Als je profielen hebt gebruikt (`--profile` / `OPENCLAW_PROFILE`), herhaal stap 3 voor elke statusmap (standaard zijn dit `~/.openclaw-<profile>`).
- In de modus op afstand bevindt de statusmap zich op de **Gateway-host**, dus voer stappen 1-4 daar ook uit.

## Handmatige serviceverwijdering (CLI niet geïnstalleerd)

Gebruik dit als de Gateway-service blijft draaien maar `openclaw` ontbreekt.

### macOS (launchd)

Het standaardlabel is `bot.molt.gateway` (of `bot.molt.<profile>`; de legacy `com.openclaw.*` kan nog bestaan):

```bash
launchctl bootout gui/$UID/bot.molt.gateway
rm -f ~/Library/LaunchAgents/bot.molt.gateway.plist
```

Als je een profiel hebt gebruikt, vervang het label en de plist-naam door `bot.molt.<profile>`. Verwijder eventuele legacy `com.openclaw.*` plists indien aanwezig.

### Linux (systemd user unit)

De standaard unitnaam is `openclaw-gateway.service` (of `openclaw-gateway-<profile>.service`):

```bash
systemctl --user disable --now openclaw-gateway.service
rm -f ~/.config/systemd/user/openclaw-gateway.service
systemctl --user daemon-reload
```

### Windows (Geplande taak)

De standaard taaknaam is `OpenClaw Gateway` (of `OpenClaw Gateway (<profile>)`).
Het taakscript bevindt zich onder je statusmap.

```powershell
schtasks /Delete /F /TN "OpenClaw Gateway"
Remove-Item -Force "$env:USERPROFILE\.openclaw\gateway.cmd"
```

Als je een profiel hebt gebruikt, verwijder de bijbehorende taaknaam en `~\.openclaw-<profile>\gateway.cmd`.

## Normale installatie vs broncheckout

### Normale installatie (install.sh / npm / pnpm / bun)

Als je `https://openclaw.ai/install.sh` of `install.ps1` hebt gebruikt, is de CLI geïnstalleerd met `npm install -g openclaw@latest`.
Verwijder deze met `npm rm -g openclaw` (of `pnpm remove -g` / `bun remove -g` als je het zo hebt geïnstalleerd).

### Broncheckout (git clone)

Als je vanuit een repo-checkout draait (`git clone` + `openclaw ...` / `bun run openclaw ...`):

1. Verwijder de Gateway-service **voordat** je de repo verwijdert (gebruik de eenvoudige route hierboven of handmatige serviceverwijdering).
2. Verwijder de repo-map.
3. Verwijder status + werkruimte zoals hierboven getoond.
