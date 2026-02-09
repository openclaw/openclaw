---
summary: "Uppdatera OpenClaw säkert (global installation eller källkod), plus strategi för återställning"
read_when:
  - Uppdatera OpenClaw
  - Något går sönder efter en uppdatering
title: "Uppdatering"
---

# Uppdatering

OpenClaw går snabbt (före “1.0”). Behandla uppdateringar som frakt infrastruktur: uppdatera → kör kontroller → omstart (eller använd `openclaw update`, som omstartar) → verifiera.

## Rekommenderat: kör webbinstallatören igen (uppgradering på plats)

Uppdateringssökvägen **föredrade** är att köra om installationsprogrammet från webbplatsen. Den
upptäcker befintliga installationer, uppgraderingar på plats och kör `openclaw doctor` när
behövs.

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

Noteringar:

- Lägg till `--no-onboard` om du inte vill att introduktionsguiden ska köras igen.

- För **källkodsinstallationer**, använd:

  ```bash
  curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --no-onboard
  ```

  Installatören kommer **endast** att `git pull --rebase` om repot är rent.

- För **globala installationer** använder skriptet `npm install -g openclaw@latest` under huven.

- Äldre notering: `clawdbot` finns kvar som ett kompatibilitetsskikt.

## Innan du uppdaterar

- Vet hur du installerade: **global** (npm/pnpm) vs **från källkod** (git clone).
- Vet hur din Gateway körs: **förgrundsterminal** vs **övervakad tjänst** (launchd/systemd).
- Ta ögonblicksbilder av dina anpassningar:
  - Konfig: `~/.openclaw/openclaw.json`
  - Autentiseringsuppgifter: `~/.openclaw/credentials/`
  - Arbetsyta: `~/.openclaw/workspace`

## Uppdatera (global installation)

Global installation (välj en):

```bash
npm i -g openclaw@latest
```

```bash
pnpm add -g openclaw@latest
```

Vi **rekommenderar inte** Bun för Gateway-körningen (WhatsApp/Telegram-buggar).

För att byta uppdateringskanaler (git- och npm-installationer):

```bash
openclaw update --channel beta
openclaw update --channel dev
openclaw update --channel stable
```

Använd `--tag <dist-tag|version>` för en engångstagg/version vid installation.

Se [Utvecklingskanaler](/install/development-channels) för kanalernas semantik och versionsanteckningar.

Obs: vid npm installerar, loggar gateway en uppdatering ledtråd vid start (kontrollerar den aktuella kanaltaggen). Inaktivera via `update.checkOnStart: false`.

Sedan:

```bash
openclaw doctor
openclaw gateway restart
openclaw health
```

Noteringar:

- Om din Gateway körs som en tjänst är `openclaw gateway restart` att föredra framför att döda PID:er.
- Om du är låst till en specifik version, se ”Återställning / låsning” nedan.

## Uppdatera (`openclaw update`)

För **källkodsinstallationer** (git checkout), föredra:

```bash
openclaw update
```

Den kör ett hyfsat säkert uppdateringsflöde:

- Kräver ett rent arbets-träd.
- Växlar till vald kanal (tagg eller gren).
- Hämtar + rebaserar mot konfigurerad upstream (dev-kanal).
- Installerar beroenden, bygger, bygger Control UI och kör `openclaw doctor`.
- Startar om gatewayen som standard (använd `--no-restart` för att hoppa över).

Om du installerade via **npm/pnpm** (ingen git metadata) kommer `openclaw update` att försöka uppdatera via din pakethanterare. Om det inte kan upptäcka installationen, använd ”Update (global install)” istället.

## Uppdatera (Control UI / RPC)

Kontrollgränssnittet har **Update & Restart** (RPC: `update.run`). Den:

1. Kör samma källkodsuppdateringsflöde som `openclaw update` (endast git checkout).
2. Skriver en omstartssentinel med en strukturerad rapport (stdout/stderr-svans).
3. Startar om gatewayen och pingar den senast aktiva sessionen med rapporten.

Om rebasen misslyckas avbryter gatewayen och startar om utan att tillämpa uppdateringen.

## Uppdatera (från källkod)

Från repo-checkouten:

Föredraget:

```bash
openclaw update
```

Manuellt (ungefär motsvarande):

```bash
git pull
pnpm install
pnpm build
pnpm ui:build # auto-installs UI deps on first run
openclaw doctor
openclaw health
```

Noteringar:

- `pnpm build` är viktigt när du kör den paketerade `openclaw`-binären ([`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs)) eller använder Node för att köra `dist/`.
- Om du kör från en repo-checkout utan global installation, använd `pnpm openclaw ...` för CLI-kommandon.
- Om du kör direkt från TypeScript (`pnpm openclaw ...`) är en ombyggnad oftast onödig, men **konfigmigreringar gäller fortfarande** → kör doctor.
- Att växla mellan global- och git-installationer är enkelt: installera den andra varianten och kör sedan `openclaw doctor` så att gatewayens tjänsteinträde skrivs om till den aktuella installationen.

## Kör alltid: `openclaw doctor`

Doktor är kommandot “safe update”. Det är avsiktligt tråkigt: reparation + migrera + varning.

Obs: om du är på en **källkodsinstallation** (git checkout) kommer `openclaw doctor` att erbjuda att köra `openclaw update` först.

Typiska saker den gör:

- Migrerar utfasade konfignycklar / äldre platser för konfigfiler.
- Granskar DM-policyer och varnar för riskabla ”öppna” inställningar.
- Kontrollerar Gateway-hälsa och kan erbjuda omstart.
- Upptäcker och migrerar äldre gateway-tjänster (launchd/systemd; äldre schtasks) till aktuella OpenClaw-tjänster.
- På Linux säkerställer systemd user lingering (så att Gateway överlever utloggning).

Detaljer: [Doctor](/gateway/doctor)

## Starta / stoppa / starta om Gateway

CLI (fungerar oavsett OS):

```bash
openclaw gateway status
openclaw gateway stop
openclaw gateway restart
openclaw gateway --port 18789
openclaw logs --follow
```

Om du är övervakad:

- macOS launchd (app-bundled LaunchAgent): `launchctl kickstart -k gui/$UID/bot.molt.gateway` (använd `bot.molt.<profile>`; äldre `com.openclaw.*` fungerar fortfarande)
- Linux systemd användartjänst: `systemctl --user restart openclaw-gateway[-<profile>].service`
- Windows (WSL2): `systemctl --user restart openclaw-gateway[-<profile>].service`
  - `launchctl`/`systemctl` fungerar bara om tjänsten är installerad; annars kör `openclaw gateway install`.

Runbook + exakta tjänstetiketter: [Gateway runbook](/gateway)

## Återställning / låsning (när något går sönder)

### Lås (global installation)

Installera en känd fungerande version (ersätt `<version>` med den senast fungerande):

```bash
npm i -g openclaw@<version>
```

```bash
pnpm add -g openclaw@<version>
```

Tips: för att se aktuell publicerad version, kör `npm view openclaw version`.

Starta sedan om + kör doctor igen:

```bash
openclaw doctor
openclaw gateway restart
```

### Lås (källkod) efter datum

Välj en commit från ett datum (exempel: ”tillståndet för main per 2026-01-01”):

```bash
git fetch origin
git checkout "$(git rev-list -n 1 --before=\"2026-01-01\" origin/main)"
```

Installera sedan om beroenden + starta om:

```bash
pnpm install
pnpm build
openclaw gateway restart
```

Om du vill gå tillbaka till senaste senare:

```bash
git checkout main
git pull
```

## Om du kör fast

- Kör `openclaw doctor` igen och läs utdata noggrant (den berättar ofta vad som behöver göras).
- Kontrollera: [Felsökning](/gateway/troubleshooting)
- Fråga i Discord: [https://discord.gg/clawd](https://discord.gg/clawd)
