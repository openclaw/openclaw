---
summary: "Installatiehandleiding voor ontwikkelaars die aan de OpenClaw macOS-app werken"
read_when:
  - Het instellen van de macOS-ontwikkelomgeving
title: "macOS Dev-installatie"
---

# macOS-ontwikkelaarsinstallatie

Deze handleiding beschrijft de noodzakelijke stappen om de OpenClaw macOS-applicatie vanaf de broncode te bouwen en uit te voeren.

## Vereisten

Zorg ervoor dat je vóór het bouwen van de app het volgende hebt geïnstalleerd:

1. **Xcode 26.2+**: Vereist voor Swift-ontwikkeling.
2. **Node.js 22+ & pnpm**: Vereist voor de Gateway, CLI en verpakkingsscripts.

## 1) Afhankelijkheden installeren

Installeer de projectbrede afhankelijkheden:

```bash
pnpm install
```

## 2. De app bouwen en verpakken

Om de macOS-app te bouwen en te verpakken in `dist/OpenClaw.app`, voer je het volgende uit:

```bash
./scripts/package-mac-app.sh
```

Als je geen Apple Developer ID-certificaat hebt, gebruikt het script automatisch **ad-hoc signing** (`-`).

Voor ontwikkel-runmodi, ondertekeningsflags en het oplossen van Team ID-problemen, zie de macOS-app README:
[https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md](https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md)

> **Let op**: Apps die ad-hoc zijn ondertekend kunnen beveiligingsmeldingen activeren. Als de app direct crasht met "Abort trap 6", zie de sectie [Problemen oplossen](#troubleshooting).

## 3. De CLI installeren

De macOS-app verwacht een globale `openclaw` CLI-installatie om achtergrondtaken te beheren.

**Om deze te installeren (aanbevolen):**

1. Open de OpenClaw-app.
2. Ga naar het tabblad **Algemeen** in de instellingen.
3. Klik op **"Install CLI"**.

Je kunt de CLI ook handmatig installeren:

```bash
npm install -g openclaw@<version>
```

## Problemen oplossen

### Build mislukt: toolchain- of SDK-mismatch

De macOS-app-build verwacht de nieuwste macOS SDK en de Swift 6.2-toolchain.

**Systeemafhankelijkheden (vereist):**

- **Nieuwste macOS-versie beschikbaar via Software-update** (vereist door Xcode 26.2 SDK's)
- **Xcode 26.2** (Swift 6.2-toolchain)

**Controles:**

```bash
xcodebuild -version
xcrun swift --version
```

Als de versies niet overeenkomen, werk macOS/Xcode bij en voer de build opnieuw uit.

### App crasht bij het verlenen van rechten

Als de app crasht wanneer je **Spraakherkenning** of **Microfoon**-toegang probeert toe te staan, kan dit komen door een beschadigde TCC-cache of een mismatch in de ondertekening.

**Oplossing:**

1. Reset de TCC-rechten:

   ```bash
   tccutil reset All bot.molt.mac.debug
   ```

2. Als dat niet werkt, wijzig tijdelijk de `BUNDLE_ID` in [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) om een "schone lei" van macOS af te dwingen.

### Gateway blijft onbeperkt op "Starting..."

Als de Gateway-status op "Starting..." blijft staan, controleer dan of een zombieproces de poort bezet houdt:

```bash
openclaw gateway status
openclaw gateway stop

# If you’re not using a LaunchAgent (dev mode / manual runs), find the listener:
lsof -nP -iTCP:18789 -sTCP:LISTEN
```

Als een handmatige run de poort bezet houdt, stop dat proces (Ctrl+C). Als laatste redmiddel kun je de hierboven gevonden PID beëindigen.
