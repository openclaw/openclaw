---
summary: "Ondertekeningsstappen voor macOS-debugbuilds die door verpakkingsscripts worden gegenereerd"
read_when:
  - Bouwen of ondertekenen van macOS-debugbuilds
title: "macOS-ondertekening"
---

# mac-ondertekening (debugbuilds)

Deze app wordt meestal gebouwd vanuit [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh), die nu:

- een stabiele debug bundle identifier instelt: `ai.openclaw.mac.debug`
- de Info.plist schrijft met die bundle-id (overschrijven via `BUNDLE_ID=...`)
- [`scripts/codesign-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/codesign-mac-app.sh) aanroept om het hoofd-binaire bestand en de app-bundle te ondertekenen, zodat macOS elke herbouw als dezelfde ondertekende bundle behandelt en TCC-rechten behoudt (meldingen, toegankelijkheid, schermopname, microfoon, spraak). Voor stabiele rechten gebruik je een echte ondertekeningsidentiteit; ad-hoc is opt-in en fragiel (zie [macOS-rechten](/platforms/mac/permissions)).
- standaard `CODESIGN_TIMESTAMP=auto` gebruikt; dit schakelt vertrouwde tijdstempels in voor Developer ID-ondertekeningen. Stel `CODESIGN_TIMESTAMP=off` in om tijdstempeling over te slaan (offline debugbuilds).
- buildmetadata injecteert in Info.plist: `OpenClawBuildTimestamp` (UTC) en `OpenClawGitCommit` (korte hash), zodat het Over-paneel build-, git- en debug/release-kanaal kan tonen.
- **Verpakken vereist Node 22+**: het script draait TS-builds en de Control UI-build.
- `SIGN_IDENTITY` uit de omgeving leest. Voeg `export SIGN_IDENTITY="Apple Development: Your Name (TEAMID)"` (of je Developer ID Application-certificaat) toe aan je shell-rc om altijd met je certificaat te ondertekenen. Ad-hoc ondertekening vereist expliciete opt-in via `ALLOW_ADHOC_SIGNING=1` of `SIGN_IDENTITY="-"` (niet aanbevolen voor het testen van rechten).
- na het ondertekenen een Team ID-audit uitvoert en faalt als een Mach-O binnen de app-bundle door een andere Team ID is ondertekend. Stel `SKIP_TEAM_ID_CHECK=1` in om dit te omzeilen.

## Gebruik

```bash
# from repo root
scripts/package-mac-app.sh               # auto-selects identity; errors if none found
SIGN_IDENTITY="Developer ID Application: Your Name" scripts/package-mac-app.sh   # real cert
ALLOW_ADHOC_SIGNING=1 scripts/package-mac-app.sh    # ad-hoc (permissions will not stick)
SIGN_IDENTITY="-" scripts/package-mac-app.sh        # explicit ad-hoc (same caveat)
DISABLE_LIBRARY_VALIDATION=1 scripts/package-mac-app.sh   # dev-only Sparkle Team ID mismatch workaround
```

### Opmerking over ad-hoc ondertekening

Bij ondertekenen met `SIGN_IDENTITY="-"` (ad-hoc) schakelt het script automatisch de **Hardened Runtime** (`--options runtime`) uit. Dit is nodig om crashes te voorkomen wanneer de app probeert ingesloten frameworks (zoals Sparkle) te laden die niet dezelfde Team ID delen. Ad-hoc ondertekeningen breken ook de persistentie van TCC-rechten; zie [macOS-rechten](/platforms/mac/permissions) voor herstelstappen.

## Buildmetadata voor Over

`package-mac-app.sh` stempelt de bundle met:

- `OpenClawBuildTimestamp`: ISO8601 UTC op verpakkingsmoment
- `OpenClawGitCommit`: korte git-hash (of `unknown` indien niet beschikbaar)

Het tabblad Over leest deze sleutels om versie, builddatum, git-commit en of het een debugbuild is te tonen (via `#if DEBUG`). Voer de packager opnieuw uit om deze waarden te verversen na codewijzigingen.

## Waarom

TCC-rechten zijn gekoppeld aan de bundle identifier _en_ de code-ondertekening. Niet-ondertekende debugbuilds met veranderende UUID's zorgden ervoor dat macOS de toekenningen na elke herbouw vergat. Het ondertekenen van de binaire bestanden (standaard ad-hoc) en het behouden van een vaste bundle-id/-pad (`dist/OpenClaw.app`) bewaart de toekenningen tussen builds, in lijn met de VibeTunnel-aanpak.
