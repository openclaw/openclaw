---
summary: "Opsætningsguide for udviklere, der arbejder på OpenClaw macOS-appen"
read_when:
  - Opsætning af macOS-udviklingsmiljøet
title: "macOS Udvikleropsætning"
---

# macOS Udvikleropsætning

Denne guide dækker de nødvendige trin for at bygge og køre OpenClaw macOS-applikationen fra kildekode.

## Forudsætninger

Før du bygger appen, skal du sikre dig, at du har følgende installeret:

1. **Xcode 26.2+**: Påkrævet til Swift-udvikling.
2. **Node.js 22+ & pnpm**: Påkrævet til gateway, CLI og pakkescripts.

## 1) Installér Afhængigheder

Installér projektets fælles afhængigheder:

```bash
pnpm install
```

## 2. Byg og Pak appen

For at bygge macOS-appen og pakke den i `dist/OpenClaw.app`, kør:

```bash
./scripts/package-mac-app.sh
```

Hvis du ikke har et Apple Developer ID-certifikat, vil scriptet automatisk bruge **ad-hoc-signering** (`-`).

For dev-kørselstilstande, signeringsflag og fejlfinding af Team ID, se macOS-appens README:
[https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md](https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md)

> **Bemærk**: Ad-hoc-underskrevne apps kan udløse sikkerhedsprompter. Hvis appen går ned med det samme med "Afbryd fælde 6", se afsnittet [Troubleshooting](#troubleshooting).

## 3. Installér CLI’en

macOS-appen forventer en global `openclaw` CLI-installation til at håndtere baggrundsopgaver.

**Sådan installerer du den (anbefalet):**

1. Åbn OpenClaw-appen.
2. Gå til fanen **General** i indstillingerne.
3. Klik på **"Install CLI"**.

Alternativt kan du installere den manuelt:

```bash
npm install -g openclaw@<version>
```

## Fejlfinding

### Build fejler: Toolchain- eller SDK-uoverensstemmelse

Buildet af macOS-appen forventer den nyeste macOS SDK og Swift 6.2 toolchain.

**Systemafhængigheder (påkrævet):**

- **Nyeste macOS-version tilgængelig i Softwareopdatering** (påkrævet af Xcode 26.2 SDK’er)
- **Xcode 26.2** (Swift 6.2 toolchain)

**Tjek:**

```bash
xcodebuild -version
xcrun swift --version
```

Hvis versionerne ikke matcher, opdatér macOS/Xcode og kør buildet igen.

### App crasher ved tilladelsestildeling

Hvis appen crasher, når du forsøger at tillade adgang til **Speech Recognition** eller **Microphone**, kan det skyldes en korrupt TCC-cache eller uoverensstemmelse i signaturen.

**Løsning:**

1. Nulstil TCC-tilladelserne:

   ```bash
   tccutil reset All bot.molt.mac.debug
   ```

2. Hvis det ikke hjælper, så ændr `BUNDLE_ID` midlertidigt i [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) for at tvinge en "clean slate" fra macOS.

### Gateway "Starting..." uendeligt

Hvis gateway-status forbliver på "Starting...", så tjek om en zombieproces holder porten:

```bash
openclaw gateway status
openclaw gateway stop

# If you’re not using a LaunchAgent (dev mode / manual runs), find the listener:
lsof -nP -iTCP:18789 -sTCP:LISTEN
```

Hvis en manuel kørsel holder porten, skal du stoppe denne proces (Ctrl+C). Som en sidste udvej, dræbe den PID du fandt ovenfor.
