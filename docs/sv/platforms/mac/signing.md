---
summary: "Signeringssteg för macOS-felsökningsbyggen som genereras av paketeringsskript"
read_when:
  - Bygger eller signerar macOS-felsökningsbyggen
title: "macOS-signering"
x-i18n:
  source_path: platforms/mac/signing.md
  source_hash: 403b92f9a0ecdb7c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:18:01Z
---

# mac-signering (felsökningsbyggen)

Den här appen byggs vanligtvis från [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh), som nu:

- sätter ett stabilt bundle-ID för debug: `ai.openclaw.mac.debug`
- skriver Info.plist med detta bundle-ID (åsidosätt via `BUNDLE_ID=...`)
- anropar [`scripts/codesign-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/codesign-mac-app.sh) för att signera huvudbinären och app-paketet så att macOS behandlar varje ombyggnad som samma signerade bundle och behåller TCC-behörigheter (notiser, hjälpmedel, skärminspelning, mikrofon, tal). För stabila behörigheter, använd en riktig signeringsidentitet; ad-hoc är frivilligt och skört (se [macOS-behörigheter](/platforms/mac/permissions)).
- använder `CODESIGN_TIMESTAMP=auto` som standard; det aktiverar betrodda tidsstämplar för Developer ID-signaturer. Sätt `CODESIGN_TIMESTAMP=off` för att hoppa över tidsstämpling (offline-felsökningsbyggen).
- injicerar byggmetadata i Info.plist: `OpenClawBuildTimestamp` (UTC) och `OpenClawGitCommit` (kort hash) så att Om-panelen kan visa build, git samt debug-/release-kanal.
- **Paketering kräver Node 22+**: skriptet kör TS-byggen och bygger Control UI.
- läser `SIGN_IDENTITY` från miljön. Lägg till `export SIGN_IDENTITY="Apple Development: Your Name (TEAMID)"` (eller ditt Developer ID Application-certifikat) i din shell rc för att alltid signera med ditt cert. Ad-hoc-signering kräver uttrycklig opt-in via `ALLOW_ADHOC_SIGNING=1` eller `SIGN_IDENTITY="-"` (rekommenderas inte för behörighetstestning).
- kör en Team ID-revision efter signering och misslyckas om någon Mach-O i app-paketet är signerad av ett annat Team ID. Sätt `SKIP_TEAM_ID_CHECK=1` för att kringgå.

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

När du signerar med `SIGN_IDENTITY="-"` (ad-hoc) inaktiverar skriptet automatiskt **Hardened Runtime** (`--options runtime`). Detta är nödvändigt för att förhindra krascher när appen försöker läsa in inbäddade ramverk (som Sparkle) som inte delar samma Team ID. Ad-hoc-signaturer bryter också TCC-behörigheternas persistens; se [macOS-behörigheter](/platforms/mac/permissions) för återställningssteg.

## Byggmetadata för Om

`package-mac-app.sh` stämplar bundlen med:

- `OpenClawBuildTimestamp`: ISO8601 UTC vid paketering
- `OpenClawGitCommit`: kort git-hash (eller `unknown` om den inte är tillgänglig)

Om-fliken läser dessa nycklar för att visa version, byggdatum, git-commit och om det är ett felsökningsbygge (via `#if DEBUG`). Kör paketeraren för att uppdatera dessa värden efter kodändringar.

## Varför

TCC-behörigheter är knutna till bundle-ID:t _och_ kodsignaturen. Osignerade felsökningsbyggen med föränderliga UUID:er gjorde att macOS glömde beviljanden efter varje ombyggnad. Genom att signera binärerna (ad-hoc som standard) och behålla ett fast bundle-ID/sökväg (`dist/OpenClaw.app`) bevaras beviljandena mellan byggen, i linje med VibeTunnel-approachen.
