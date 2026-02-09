---
summary: "Konfigureringsguide för utvecklare som arbetar med OpenClaw macOS-appen"
read_when:
  - Konfigurera macOS-utvecklingsmiljön
title: "macOS-utvecklarsetup"
---

# macOS-utvecklarsetup

Den här guiden beskriver de nödvändiga stegen för att bygga och köra OpenClaw macOS-applikationen från källkod.

## Förutsättningar

Innan du bygger appen, säkerställ att du har följande installerat:

1. **Xcode 26.2+**: Krävs för Swift-utveckling.
2. **Node.js 22+ & pnpm**: Krävs för gateway (nätverksgateway), CLI och paketeringsskript.

## 1) Installera beroenden

Installera projektets gemensamma beroenden:

```bash
pnpm install
```

## 2. Bygg och paketera appen

För att bygga macOS-appen och paketera den till `dist/OpenClaw.app`, kör:

```bash
./scripts/package-mac-app.sh
```

Om du inte har ett Apple Developer ID-certifikat kommer skriptet automatiskt att använda **ad-hoc-signering** (`-`).

För utvecklingskörlägen, signeringsflaggor och felsökning av Team ID, se macOS-appens README:
[https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md](https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md)

> **Observera**: Ad-hoc signerade appar kan utlösa säkerhetsmeddelanden. Om appen kraschar omedelbart med "Avbryt fällan 6", se avsnittet [Troubleshooting](#troubleshooting) .

## 3. Installera CLI

macOS-appen förväntar sig en global `openclaw`-CLI-installation för att hantera bakgrundsuppgifter.

**Så installerar du den (rekommenderas):**

1. Öppna OpenClaw-appen.
2. Gå till inställningsfliken **Allmänt**.
3. Klicka på **”Installera CLI”**.

Alternativt kan du installera den manuellt:

```bash
npm install -g openclaw@<version>
```

## Felsökning

### Bygget misslyckas: Verktygskedja eller SDK stämmer inte

Bygget av macOS-appen förväntar sig den senaste macOS SDK:n och Swift 6.2-verktygskedjan.

**Systemberoenden (krävs):**

- **Senaste macOS-versionen som finns tillgänglig via Programuppdatering** (krävs av Xcode 26.2 SDK:er)
- **Xcode 26.2** (Swift 6.2-verktygskedja)

**Kontroller:**

```bash
xcodebuild -version
xcrun swift --version
```

Om versionerna inte matchar, uppdatera macOS/Xcode och kör bygget igen.

### Appen kraschar vid tilldelning av behörigheter

Om appen kraschar när du försöker tillåta åtkomst till **Taligenkänning** eller **Mikrofon**, kan det bero på en skadad TCC-cache eller en signaturkonflikt.

**Åtgärd:**

1. Återställ TCC-behörigheterna:

   ```bash
   tccutil reset All bot.molt.mac.debug
   ```

2. Om det inte hjälper, ändra `BUNDLE_ID` tillfälligt i [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) för att tvinga en ”ren start” från macOS.

### Gateway (nätverksgateway) ”Starting...” i all oändlighet

Om gateway-statusen förblir ”Starting...”, kontrollera om en zombieprocess håller porten:

```bash
openclaw gateway status
openclaw gateway stop

# If you’re not using a LaunchAgent (dev mode / manual runs), find the listener:
lsof -nP -iTCP:18789 -sTCP:LISTEN
```

Om en manuell körning håller i hamnen, stoppa den processen (Ctrl+C). Som en sista utväg, döda PID du hittat ovan.
