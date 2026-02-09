---
summary: "Signeringstrin for macOS-debug-builds genereret af pakkescripts"
read_when:
  - Bygning eller signering af macOS-debug-builds
title: "macOS-signering"
---

# mac-signering (debug-builds)

Denne app bygges normalt fra [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh), som nu:

- sætter en stabil debug bundle identifier: `ai.openclaw.mac.debug`
- skriver Info.plist med den bundle-id (kan tilsidesættes via `BUNDLE_ID=...`)
- opkald [`scripts/codesign-mac-app. h`](https://github.com/openclaw/openclaw/blob/main/scripts/codesign-mac-app.sh) for at underskrive den vigtigste binære og app pakke så macOS behandler hver genopbygge som den samme underskrevet pakke og holder TCC tilladelser (meddelelser, tilgængelighed, skærmoptagelse, mikrofon, tale). For stabile tilladelser skal du bruge en rigtig signeringsidentitet; ad hoc er opt-in og skrøbelig (se [macOS tilladelser] (/platforms/mac/permissions)).
- bruger `CODESIGN_ TIMESTAMP=auto` som standard; det muliggør betroede tidsstempler for udvikler-ID signaturer. Sæt `CODESIGN_TIMESTAMP=off` for at springe tidsstempling over (offline debug builds).
- injicerer build-metadata i Info.plist: `OpenClawBuildTimestamp` (UTC) og `OpenClawGitCommit` (kort hash), så Om-panelet kan vise build, git og debug/release-kanal.
- **Pakning kræver Node 22+**: scriptet kører TS-builds og Control UI-buildet.
- læses `SIGN_IDENTITY` fra miljøet. Tilføj `export SIGN_IDENTITY="Apple Development: Dit navn (TEAMID)"` (eller dit udvikler-id-program) til din shell rc for altid at underskrive med dit certifikat. Ad-hoc signering kræver eksplicit opt-in via `ALLOW_ADHOC_SIGNING=1` eller `SIGN_IDENTITY="-"` (ikke anbefalet til tilladelsestest).
- kører en Team ID revision efter signering og mislykkes, hvis nogen Mach-O inde i app-pakken er underskrevet af et andet Team ID. Sæt `SKIP_TEAM_ID_CHECK=1` for at forbigå.

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

Ved signering med `SIGN_IDENTITY="-"` (ad-hoc), deaktiverer scriptet automatisk den **Hardened Runtime** (`--options runtime`). Dette er nødvendigt for at forhindre nedbrud, når app'en forsøger at indlæse indlejrede rammer (som Sparkle), der ikke deler det samme Team ID. Ad-hoc signaturer også bryde TCC tilladelse persistence; se [macOS tilladelser] (/platforms/mac/permissions) for genoprettelsestrin.

## Build-metadata til Om

`package-mac-app.sh` stempler bundlen med:

- `OpenClawBuildTimestamp`: ISO8601 UTC på pakketidspunktet
- `OpenClawGitCommit`: kort git-hash (eller `unknown` hvis utilgængelig)

Fanebladet Om læser disse nøgler til at vise version, bygge dato, git commit, og om det er en debug build (via `#if DEBUG`). Kør pakkeren for at opdatere disse værdier efter kodeændringer.

## Hvorfor

TCC tilladelser er bundet til bundle identifier _and_ kode signatur. Usigneret fejlfinding bygger med skiftende UUID'er fik macOS til at glemme tilskud efter hver genopbygning. Underskrift af binære filer (ad hoc som standard) og opretholdelse af et fast bundt id/path (`dist/OpenClaw.app`) bevarer tilskuddene mellem bygninger, der stemmer overens med VibeTunnel tilgang.
