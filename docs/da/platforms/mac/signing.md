---
summary: "Signeringstrin for macOS-debug-builds genereret af pakkescripts"
read_when:
  - Bygning eller signering af macOS-debug-builds
title: "macOS-signering"
x-i18n:
  source_path: platforms/mac/signing.md
  source_hash: 403b92f9a0ecdb7c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:30Z
---

# mac-signering (debug-builds)

Denne app bygges normalt fra [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh), som nu:

- sætter en stabil debug bundle identifier: `ai.openclaw.mac.debug`
- skriver Info.plist med den bundle-id (kan tilsidesættes via `BUNDLE_ID=...`)
- kalder [`scripts/codesign-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/codesign-mac-app.sh) for at signere hovedbinæren og app-bundlen, så macOS behandler hver genbygning som den samme signerede bundle og bevarer TCC-tilladelser (notifikationer, tilgængelighed, skærmoptagelse, mikrofon, tale). For stabile tilladelser skal du bruge en rigtig signeringsidentitet; ad-hoc er valgfrit og skrøbeligt (se [macOS permissions](/platforms/mac/permissions)).
- bruger `CODESIGN_TIMESTAMP=auto` som standard; den aktiverer betroede tidsstempler for Developer ID-signaturer. Sæt `CODESIGN_TIMESTAMP=off` for at springe tidsstempling over (offline debug-builds).
- injicerer build-metadata i Info.plist: `OpenClawBuildTimestamp` (UTC) og `OpenClawGitCommit` (kort hash), så Om-panelet kan vise build, git og debug/release-kanal.
- **Pakning kræver Node 22+**: scriptet kører TS-builds og Control UI-buildet.
- læser `SIGN_IDENTITY` fra miljøet. Tilføj `export SIGN_IDENTITY="Apple Development: Your Name (TEAMID)"` (eller dit Developer ID Application-certifikat) til din shell-rc for altid at signere med dit certifikat. Ad-hoc-signering kræver eksplicit tilvalg via `ALLOW_ADHOC_SIGNING=1` eller `SIGN_IDENTITY="-"` (anbefales ikke til test af tilladelser).
- kører et Team ID-tjek efter signering og fejler, hvis nogen Mach-O inde i app-bundlen er signeret af et andet Team ID. Sæt `SKIP_TEAM_ID_CHECK=1` for at omgå dette.

## Brug

```bash
# from repo root
scripts/package-mac-app.sh               # auto-selects identity; errors if none found
SIGN_IDENTITY="Developer ID Application: Your Name" scripts/package-mac-app.sh   # real cert
ALLOW_ADHOC_SIGNING=1 scripts/package-mac-app.sh    # ad-hoc (permissions will not stick)
SIGN_IDENTITY="-" scripts/package-mac-app.sh        # explicit ad-hoc (same caveat)
DISABLE_LIBRARY_VALIDATION=1 scripts/package-mac-app.sh   # dev-only Sparkle Team ID mismatch workaround
```

### Bemærkning om ad-hoc-signering

Når der signeres med `SIGN_IDENTITY="-"` (ad-hoc), deaktiverer scriptet automatisk **Hardened Runtime** (`--options runtime`). Dette er nødvendigt for at forhindre nedbrud, når appen forsøger at indlæse indlejrede frameworks (som Sparkle), der ikke deler samme Team ID. Ad-hoc-signaturer ødelægger også vedvarende TCC-tilladelser; se [macOS permissions](/platforms/mac/permissions) for gendannelsestrin.

## Build-metadata til Om

`package-mac-app.sh` stempler bundlen med:

- `OpenClawBuildTimestamp`: ISO8601 UTC på pakketidspunktet
- `OpenClawGitCommit`: kort git-hash (eller `unknown` hvis utilgængelig)

Om-fanen læser disse nøgler for at vise version, build-dato, git-commit og om det er et debug-build (via `#if DEBUG`). Kør pakkeren for at opdatere disse værdier efter kodeændringer.

## Hvorfor

TCC-tilladelser er knyttet til bundle identifier _og_ kodesignatur. Usignerede debug-builds med skiftende UUID’er fik macOS til at glemme tildelinger efter hver genbygning. Signering af binærerne (ad-hoc som standard) og fastholdelse af en fast bundle-id/sti (`dist/OpenClaw.app`) bevarer tilladelserne mellem builds og matcher VibeTunnel-tilgangen.
