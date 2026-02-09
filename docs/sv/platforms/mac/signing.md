---
summary: "Signeringssteg för macOS-felsökningsbyggen som genereras av paketeringsskript"
read_when:
  - Bygger eller signerar macOS-felsökningsbyggen
title: "macOS-signering"
---

# mac-signering (felsökningsbyggen)

Den här appen byggs vanligtvis från [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh), som nu:

- sätter ett stabilt bundle-ID för debug: `ai.openclaw.mac.debug`
- skriver Info.plist med detta bundle-ID (åsidosätt via `BUNDLE_ID=...`)
- anrop [`scripts/codesign-mac-app. h`](https://github.com/openclaw/openclaw/blob/main/scripts/codesign-mac-app.sh) för att signera huvudbinär och app bunt så macOS behandlar varje ombyggnad som samma signerade bunt och behåller TCC-behörigheter (notifikationer, tillgänglighet, skärminspelning, mikrofon, tal). För stabila behörigheter, använd en riktig signeringsidentitet, ad-hoc är opt-in och bräcklig (se [macOS behörigheter](/platforms/mac/permissions)).
- använder `CODESIGN_TIMESTAMP=auto` som standard; det möjliggör betrodda tidsstämplar för utvecklarID-signaturer. Sätt `CODESIGN_TIMESTAMP=off` till att hoppa över tidsstämpling (offline debug builds).
- injicerar byggmetadata i Info.plist: `OpenClawBuildTimestamp` (UTC) och `OpenClawGitCommit` (kort hash) så att Om-panelen kan visa build, git samt debug-/release-kanal.
- **Paketering kräver Node 22+**: skriptet kör TS-byggen och bygger Control UI.
- läser `SIGN_IDENTITY` från omgivningen. Lägg till `export SIGN_IDENTITY="Apple Development: Your Name (TEAMID)"` (eller ditt utvecklarID Application cert) till din shell rc för att alltid signera med ditt cert. Ad-hoc signering kräver explicit opt-in via `ALLOW_ADHOC_SIGNING=1` eller `SIGN_IDENTITY="-"` (rekommenderas inte för behörighetstestning).
- kör en Team ID revision efter signering och misslyckas om någon Mach-O inuti appen bunt är signerad av ett annat Team ID. Sätt `SKIP_TEAM_ID_CHECK=1` till bypass.

## Användning

```bash
# from repo root
scripts/package-mac-app.sh               # auto-selects identity; errors if none found
SIGN_IDENTITY="Developer ID Application: Your Name" scripts/package-mac-app.sh   # real cert
ALLOW_ADHOC_SIGNING=1 scripts/package-mac-app.sh    # ad-hoc (permissions will not stick)
SIGN_IDENTITY="-" scripts/package-mac-app.sh        # explicit ad-hoc (same caveat)
DISABLE_LIBRARY_VALIDATION=1 scripts/package-mac-app.sh   # dev-only Sparkle Team ID mismatch workaround
```

### Notering om ad-hoc-signering

När du signerar med `SIGN_IDENTITY="-"` (ad-hoc) inaktiverar skriptet automatiskt **härdad körtid** (`--options runtime`). Detta är nödvändigt för att förhindra kraschar när appen försöker ladda inbäddade ramar (som Sparkle) som inte delar samma Team ID. Ad-hoc signaturer bryter också TCC behörighetsbeständighet; se [macOS behörigheter](/platforms/mac/permissions) för återställningssteg.

## Byggmetadata för Om

`package-mac-app.sh` stämplar bundlen med:

- `OpenClawBuildTimestamp`: ISO8601 UTC vid paketering
- `OpenClawGitCommit`: kort git-hash (eller `unknown` om den inte är tillgänglig)

Fliken Om läser dessa nycklar för att visa versionen, byggdatum, git commit, och om det är en debug build (via `#if DEBUG`). Kör paketet för att uppdatera dessa värden efter kodändringar.

## Varför

TCC-behörigheter är knutna till paketidentifieraren _och_ kodsignatur. Osignerade debug kompileringar med ändrade UUID:er fick macOS att glömma bidrag efter varje rebuild. Undertecknandet av binärerna (ad‐hoc som standard) och behållandet av en fast bunt-id/sökväg (`dist/OpenClaw.app`) bevarar bidragen mellan byggen och matchar VibeTunnel tillvägagångssättet.
