---
summary: "OpenClaw veilig updaten (globale installatie of vanuit bron), plus rollbackstrategie"
read_when:
  - OpenClaw updaten
  - Iets breekt na een update
title: "Updaten"
---

# Updaten

OpenClaw ontwikkelt zich snel (pre “1.0”). Behandel updates als het uitrollen van infrastructuur: update → controles uitvoeren → herstarten (of gebruik `openclaw update`, dat herstart) → verifiëren.

## Aanbevolen: de website‑installer opnieuw uitvoeren (in‑place upgrade)

Het **voorkeurs**updatepad is het opnieuw uitvoeren van de installer vanaf de website. Deze
detecteert bestaande installaties, voert een in‑place upgrade uit en draait `openclaw doctor` wanneer nodig.

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

Notities:

- Voeg `--no-onboard` toe als je niet wilt dat de onboarding‑wizard opnieuw wordt gestart.

- Voor **broninstallaties**, gebruik:

  ```bash
  curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --no-onboard
  ```

  De installer zal `git pull --rebase` **alleen** uitvoeren als de repo schoon is.

- Voor **globale installaties** gebruikt het script onder de motorkap `npm install -g openclaw@latest`.

- Legacy‑notitie: `clawdbot` blijft beschikbaar als compatibiliteits‑shim.

## Vóór je update

- Weet hoe je hebt geïnstalleerd: **globaal** (npm/pnpm) vs **vanuit bron** (git clone).
- Weet hoe je Gateway draait: **voorgrondterminal** vs **beheerde service** (launchd/systemd).
- Maak een snapshot van je maatwerk:
  - Config: `~/.openclaw/openclaw.json`
  - Inloggegevens: `~/.openclaw/credentials/`
  - Werkruimte: `~/.openclaw/workspace`

## Update (globale installatie)

Globale installatie (kies er één):

```bash
npm i -g openclaw@latest
```

```bash
pnpm add -g openclaw@latest
```

We raden Bun **niet** aan voor de Gateway‑runtime (WhatsApp/Telegram‑bugs).

Om updatekanalen te wisselen (git‑ en npm‑installaties):

```bash
openclaw update --channel beta
openclaw update --channel dev
openclaw update --channel stable
```

Gebruik `--tag <dist-tag|version>` voor een eenmalige installatietag/versie.

Zie [Development channels](/install/development-channels) voor kanaalsemantiek en release‑notes.

Let op: bij npm‑installaties logt de gateway bij het opstarten een update‑hint (controleert de huidige kanaaltag). Uitschakelen via `update.checkOnStart: false`.

Daarna:

```bash
openclaw doctor
openclaw gateway restart
openclaw health
```

Notities:

- Als je Gateway als service draait, heeft `openclaw gateway restart` de voorkeur boven het killen van PID’s.
- Als je vastgepind bent op een specifieke versie, zie “Rollback / pinning” hieronder.

## Update (`openclaw update`)

Voor **broninstallaties** (git checkout) heeft de voorkeur:

```bash
openclaw update
```

Dit draait een veilig‑achtige updateflow:

- Vereist een schone worktree.
- Schakelt over naar het geselecteerde kanaal (tag of branch).
- Haalt op + rebase tegen de geconfigureerde upstream (dev‑kanaal).
- Installeert dependencies, bouwt, bouwt de Control UI en draait `openclaw doctor`.
- Herstart standaard de gateway (gebruik `--no-restart` om over te slaan).

Als je via **npm/pnpm** hebt geïnstalleerd (geen git‑metadata), zal `openclaw update` proberen te updaten via je package manager. Als de installatie niet kan worden gedetecteerd, gebruik dan “Update (globale installatie)”.

## Update (Control UI / RPC)

De Control UI heeft **Update & Restart** (RPC: `update.run`). Deze:

1. Draait dezelfde bron‑updateflow als `openclaw update` (alleen git checkout).
2. Schrijft een herstart‑sentinel met een gestructureerd rapport (stdout/stderr‑tail).
3. Herstart de gateway en pingt de laatst actieve sessie met het rapport.

Als de rebase faalt, breekt de gateway af en herstart zonder de update toe te passen.

## Update (vanuit bron)

Vanuit de repo‑checkout:

Voorkeur:

```bash
openclaw update
```

Handmatig (ongeveer equivalent):

```bash
git pull
pnpm install
pnpm build
pnpm ui:build # auto-installs UI deps on first run
openclaw doctor
openclaw health
```

Notities:

- `pnpm build` is belangrijk wanneer je de verpakte `openclaw`‑binary ([`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs)) draait of Node gebruikt om `dist/` te starten.
- Als je vanuit een repo‑checkout draait zonder globale installatie, gebruik `pnpm openclaw ...` voor CLI‑opdrachten.
- Als je direct vanuit TypeScript draait (`pnpm openclaw ...`), is een rebuild meestal niet nodig, maar **config‑migraties zijn nog steeds van toepassing** → draai doctor.
- Wisselen tussen globale en git‑installaties is eenvoudig: installeer de andere variant en draai vervolgens `openclaw doctor` zodat het gateway‑service‑entrypoint wordt herschreven naar de huidige installatie.

## Altijd uitvoeren: `openclaw doctor`

Doctor is de “veilige update”‑opdracht. Hij is bewust saai: repareren + migreren + waarschuwen.

Let op: als je op een **broninstallatie** zit (git checkout), zal `openclaw doctor` aanbieden om eerst `openclaw update` uit te voeren.

Typische zaken die hij doet:

- Migreren van verouderde config‑sleutels / legacy config‑bestandslocaties.
- DM‑beleid auditen en waarschuwen bij risicovolle “open” instellingen.
- Gateway‑gezondheid controleren en eventueel een herstart voorstellen.
- Oudere gateway‑services detecteren en migreren (launchd/systemd; legacy schtasks) naar huidige OpenClaw‑services.
- Op Linux: systemd user lingering afdwingen (zodat de Gateway na uitloggen blijft draaien).

Details: [Doctor](/gateway/doctor)

## Starten / stoppen / herstarten van de Gateway

CLI (werkt ongeacht OS):

```bash
openclaw gateway status
openclaw gateway stop
openclaw gateway restart
openclaw gateway --port 18789
openclaw logs --follow
```

Als je beheerd draait:

- macOS launchd (app‑gebundelde LaunchAgent): `launchctl kickstart -k gui/$UID/bot.molt.gateway` (gebruik `bot.molt.<profile>`; legacy `com.openclaw.*` werkt nog steeds)
- Linux systemd user service: `systemctl --user restart openclaw-gateway[-<profile>].service`
- Windows (WSL2): `systemctl --user restart openclaw-gateway[-<profile>].service`
  - `launchctl`/`systemctl` werken alleen als de service is geïnstalleerd; anders draai `openclaw gateway install`.

Runbook + exacte servicelabels: [Gateway runbook](/gateway)

## Rollback / pinning (wanneer iets breekt)

### Pinnen (globale installatie)

Installeer een bekende goede versie (vervang `<version>` door de laatst werkende):

```bash
npm i -g openclaw@<version>
```

```bash
pnpm add -g openclaw@<version>
```

Tip: om de huidige gepubliceerde versie te zien, draai `npm view openclaw version`.

Herstart daarna + draai doctor opnieuw:

```bash
openclaw doctor
openclaw gateway restart
```

### Pinnen (bron) op datum

Kies een commit op basis van een datum (voorbeeld: “status van main per 2026‑01‑01”):

```bash
git fetch origin
git checkout "$(git rev-list -n 1 --before=\"2026-01-01\" origin/main)"
```

Installeer daarna dependencies opnieuw + herstart:

```bash
pnpm install
pnpm build
openclaw gateway restart
```

Als je later terug wilt naar de nieuwste versie:

```bash
git checkout main
git pull
```

## Als je vastzit

- Draai `openclaw doctor` opnieuw en lees de uitvoer zorgvuldig (vaak staat de oplossing erin).
- Bekijk: [Problemen oplossen](/gateway/troubleshooting)
- Vraag het in Discord: [https://discord.gg/clawd](https://discord.gg/clawd)
