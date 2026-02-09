---
summary: "Avinstallera OpenClaw helt (CLI, tjänst, tillstånd, arbetsyta)"
read_when:
  - Du vill ta bort OpenClaw från en maskin
  - Gateway-tjänsten körs fortfarande efter avinstallation
title: "Avinstallera"
---

# Avinstallera

Två vägar:

- **Enkel väg** om `openclaw` fortfarande är installerad.
- **Manuell borttagning av tjänst** om CLI saknas men tjänsten fortfarande körs.

## Enkel väg (CLI fortfarande installerad)

Rekommenderat: använd den inbyggda avinstalleraren:

```bash
openclaw uninstall
```

Icke-interaktivt (automatisering / npx):

```bash
openclaw uninstall --all --yes --non-interactive
npx -y openclaw uninstall --all --yes --non-interactive
```

Manuella steg (samma resultat):

1. Stoppa gateway-tjänsten:

```bash
openclaw gateway stop
```

2. Avinstallera gateway-tjänsten (launchd/systemd/schtasks):

```bash
openclaw gateway uninstall
```

3. Ta bort tillstånd + konfig:

```bash
rm -rf "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
```

Om du satte `OPENCLAW_CONFIG_PATH` till en anpassad plats utanför tillståndskatalogen, ta bort den filen också.

4. Ta bort din arbetsyta (valfritt, tar bort agentfiler):

```bash
rm -rf ~/.openclaw/workspace
```

5. Ta bort CLI-installationen (välj den du använde):

```bash
npm rm -g openclaw
pnpm remove -g openclaw
bun remove -g openclaw
```

6. Om du installerade macOS-appen:

```bash
rm -rf /Applications/OpenClaw.app
```

Noteringar:

- Om du använde profiler (`--profile` / `OPENCLAW_PROFILE`), upprepa steg 3 för varje tillståndskatalog (standardvärden är `~/.openclaw-<profile>`).
- I fjärrläge ligger tillståndskatalogen på **gateway-värden**, så kör steg 1–4 där också.

## Manuell borttagning av tjänst (CLI inte installerad)

Använd detta om gateway-tjänsten fortsätter att köras men `openclaw` saknas.

### macOS (launchd)

Standardetikett är `bot.molt.gateway` (eller `bot.molt.<profile>`; äldre `com.openclaw.*` kan fortfarande finnas):

```bash
launchctl bootout gui/$UID/bot.molt.gateway
rm -f ~/Library/LaunchAgents/bot.molt.gateway.plist
```

Om du använde en profil, ersätt etiketten och plist namnet med `bot.molt.<profile>`. Ta bort alla äldre `com.openclaw.*` listor om närvarande.

### Linux (systemd användarenhet)

Standardnamnet på enheten är `openclaw-gateway.service` (eller `openclaw-gateway-<profile>.service`):

```bash
systemctl --user disable --now openclaw-gateway.service
rm -f ~/.config/systemd/user/openclaw-gateway.service
systemctl --user daemon-reload
```

### Windows (Schemalagd uppgift)

Standardnamnet för uppgiften är `OpenClaw Gateway` (eller `OpenClaw Gateway (<profile>)`).
Uppgiften skriptet lever under ditt tillstånd dir.

```powershell
schtasks /Delete /F /TN "OpenClaw Gateway"
Remove-Item -Force "$env:USERPROFILE\.openclaw\gateway.cmd"
```

Om du använde en profil, ta bort motsvarande uppgiftsnamn och `~\.openclaw-<profile>\gateway.cmd`.

## Normal installation vs källkodsutcheckning

### Normal installation (install.sh / npm / pnpm / bun)

Om du använde `https://openclaw.ai/install.sh` eller `install.ps1`, installerades CLI med `npm install -g openclaw@latest`.
Ta bort den med `npm rm -g openclaw` (eller `pnpm remove -g` / `bun remove -g` om du installerade på det sättet).

### Källkodsutcheckning (git clone)

Om du kör från en repo-utcheckning (`git clone` + `openclaw ...` / `bun run openclaw ...`):

1. Avinstallera gateway-tjänsten **innan** du tar bort repot (använd den enkla vägen ovan eller manuell borttagning av tjänst).
2. Ta bort repokatalogen.
3. Ta bort tillstånd + arbetsyta enligt ovan.
