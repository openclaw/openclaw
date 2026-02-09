---
summary: "Opdatering af OpenClaw på en sikker måde (global installation eller fra kilde) samt rollback-strategi"
read_when:
  - Opdatering af OpenClaw
  - Noget går i stykker efter en opdatering
title: "Opdatering"
---

# Opdatering

OpenClaw bevæger sig hurtigt (før “1.0”). Behandl opdateringer som forsendelsesinfrastruktur: opdatering → Kør kontrol → Genstart (eller brug `openclaw opdatering`, som genstarter) → Bekræft.

## Anbefalet: kør web-installationsprogrammet igen (opgrader på stedet)

Den **foretrækkede** opdateringsstien er at køre installationsprogrammet igen fra hjemmesiden. Det
registrerer eksisterende installationer, opgraderinger på plads, og kører 'openclaw doctor', når
er nødvendigt.

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

Noter:

- Tilføj `--no-onboard`, hvis du ikke vil have introduktionsguiden til at køre igen.

- For **kildeinstallationer**, brug:

  ```bash
  curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --no-onboard
  ```

  Installationsprogrammet vil `git pull --rebase` **kun**, hvis repoet er rent.

- For **globale installationer** bruger scriptet `npm install -g openclaw@latest` under motorhjelmen.

- Legacy-note: `clawdbot` er fortsat tilgængelig som kompatibilitetsshim.

## Før du opdaterer

- Vid, hvordan du installerede: **global** (npm/pnpm) vs **fra kilde** (git clone).
- Vid, hvordan din Gateway kører: **forgrundsterminal** vs **overvåget service** (launchd/systemd).
- Tag snapshots af din tilpasning:
  - Konfiguration: `~/.openclaw/openclaw.json`
  - Legitimationsoplysninger: `~/.openclaw/credentials/`
  - Arbejdsområde: `~/.openclaw/workspace`

## Opdatering (global installation)

Global installation (vælg én):

```bash
npm i -g openclaw@latest
```

```bash
pnpm add -g openclaw@latest
```

Vi **anbefaler ikke** Bun til Gateway-runtime (WhatsApp/Telegram-fejl).

Sådan skifter du opdateringskanal (git + npm-installationer):

```bash
openclaw update --channel beta
openclaw update --channel dev
openclaw update --channel stable
```

Brug `--tag <dist-tag|version>` til et engangs-installationstag/-version.

Se [Udviklingskanaler](/install/development-channels) for kanalsemantik og release-noter.

Bemærk: på npm installerer, gateway logger en opdatering tip ved opstart (kontrollerer den aktuelle kanal tag). Deaktiver via `update.checkOnStart: false`.

Derefter:

```bash
openclaw doctor
openclaw gateway restart
openclaw health
```

Noter:

- Hvis din Gateway kører som en service, foretrækkes `openclaw gateway restart` frem for at dræbe PID’er.
- Hvis du er fastlåst til en specifik version, se “Rollback / fastlåsning” nedenfor.

## Opdatering (`openclaw update`)

For **kildeinstallationer** (git checkout) anbefales:

```bash
openclaw update
```

Den kører et nogenlunde sikkert opdateringsflow:

- Kræver et rent worktree.
- Skifter til den valgte kanal (tag eller branch).
- Fetcher + rebaser mod den konfigurerede upstream (dev-kanal).
- Installerer afhængigheder, bygger, bygger Control UI og kører `openclaw doctor`.
- Genstarter gatewayen som standard (brug `--no-restart` for at springe over).

Hvis du har installeret via **npm/pnpm** (ingen git metadata), 'openclaw update' vil forsøge at opdatere via din pakkehåndtering. Hvis det ikke kan registrere installationen, skal du bruge “Opdater (global installation)” i stedet.

## Opdatering (Control UI / RPC)

Brugergrænsefladen til kontrol har \*\*Opdatér og genstart \*\* (RPC: `update.run`). D.:

1. Kører samme kilde-opdateringsflow som `openclaw update` (kun git checkout).
2. Skriver en genstarts-sentinel med en struktureret rapport (stdout/stderr-hale).
3. Genstarter gatewayen og pinger den sidst aktive session med rapporten.

Hvis rebasen fejler, afbryder gatewayen og genstarter uden at anvende opdateringen.

## Opdatering (fra kilde)

Fra repo-checkout:

Foretrukket:

```bash
openclaw update
```

Manuelt (nogenlunde tilsvarende):

```bash
git pull
pnpm install
pnpm build
pnpm ui:build # auto-installs UI deps on first run
openclaw doctor
openclaw health
```

Noter:

- `pnpm build` er vigtigt, når du kører den pakkede `openclaw`-binær ([`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs)) eller bruger Node til at køre `dist/`.
- Hvis du kører fra et repo-checkout uden en global installation, brug `pnpm openclaw ...` til CLI-kommandoer.
- Hvis du kører direkte fra TypeScript (`pnpm openclaw ...`), er en genbygning som regel unødvendig, men **konfigurationsmigrationer gælder stadig** → kør doctor.
- Det er nemt at skifte mellem globale og git-installationer: installér den anden variant, og kør derefter `openclaw doctor`, så gatewayens service-entrypoint omskrives til den aktuelle installation.

## Kør altid: `openclaw doctor`

Læge er kommandoen “sikker opdatering”. Det er bevidst kedeligt: reparation + migrere + advarsel.

Note: hvis du er på en **kildeinstallation** (git checkout), vil `openclaw doctor` tilbyde at køre `openclaw update` først.

Typiske ting, den gør:

- Migrerer forældede konfigurationsnøgler / legacy-konfigurationsfilplaceringer.
- Reviderer DM-politikker og advarer om risikable “åbne” indstillinger.
- Tjekker Gateway-helbred og kan tilbyde at genstarte.
- Registrerer og migrerer ældre gateway-services (launchd/systemd; legacy schtasks) til aktuelle OpenClaw-services.
- På Linux sikrer den systemd user lingering (så Gateway overlever logout).

Detaljer: [Doctor](/gateway/doctor)

## Start / stop / genstart Gateway

CLI (virker uanset OS):

```bash
openclaw gateway status
openclaw gateway stop
openclaw gateway restart
openclaw gateway --port 18789
openclaw logs --follow
```

Hvis du er overvåget:

- macOS launchd (app-bundtet LaunchAgent): `launchctl kickstart -k gui/$UID/bot.molt.gateway` (brug `bot.molt.<profile>`; arv `com.openclaw.*` stadig virker)
- Linux systemd user service: `systemctl --user restart openclaw-gateway[-<profile>].service`
- Windows (WSL2): `systemctl --user restart openclaw-gateway[-<profile>].service`
  - `launchctl`/`systemctl` virker kun, hvis servicen er installeret; ellers kør `openclaw gateway install`.

Runbook + præcise serviceetiketter: [Gateway runbook](/gateway)

## Rollback / fastlåsning (når noget går i stykker)

### Fastlås (global installation)

Installér en kendt fungerende version (erstat `<version>` med den sidst fungerende):

```bash
npm i -g openclaw@<version>
```

```bash
pnpm add -g openclaw@<version>
```

Tip: for at se den aktuelt udgivne version, kør `npm view openclaw version`.

Genstart derefter + kør doctor igen:

```bash
openclaw doctor
openclaw gateway restart
```

### Fastlås (kilde) efter dato

Vælg et commit fra en dato (eksempel: “tilstanden af main pr. 2026-01-01”):

```bash
git fetch origin
git checkout "$(git rev-list -n 1 --before=\"2026-01-01\" origin/main)"
```

Installer derefter afhængigheder igen + genstart:

```bash
pnpm install
pnpm build
openclaw gateway restart
```

Hvis du vil tilbage til seneste senere:

```bash
git checkout main
git pull
```

## Hvis du sidder fast

- Kør `openclaw doctor` igen og læs outputtet omhyggeligt (det fortæller ofte, hvad løsningen er).
- Tjek: [Fejlfinding](/gateway/troubleshooting)
- Spørg i Discord: [https://discord.gg/clawd](https://discord.gg/clawd)
