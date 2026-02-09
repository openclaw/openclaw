---
summary: "Stabile, beta- og dev-kanaler: semantik, skift og tagging"
read_when:
  - Du vil skifte mellem stable/beta/dev
  - Du tagger eller udgiver prereleases
title: "Udviklingskanaler"
---

# Udviklingskanaler

Sidst opdateret: 2026-01-21

OpenClaw leverer tre opdateringskanaler:

- **stable**: npm dist-tag `latest`.
- **beta**: npm dist-tag `beta` (builds under test).
- **dev**: flytter hovedet af `main` (git). npm dist-tag: `dev` (når publiceret).

Vi leverer builds til **beta**, tester dem og **promoverer derefter et valideret build til `latest`**
uden at ændre versionsnummeret — dist-tags er sandhedskilden for npm-installationer.

## Skift af kanal

Git checkout:

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

- `stable`/`beta` checker det seneste matchende tag ud (ofte det samme tag).
- `dev` skifter til `main` og rebaser på upstream.

npm/pnpm global installation:

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

Dette opdaterer via det tilsvarende npm dist-tag (`latest`, `beta`, `dev`).

Når du **eksplicit** skifter kanal med `--channel`, justerer OpenClaw også
installationsmetoden:

- `dev` sikrer et git checkout (standard `~/openclaw`, kan tilsidesættes med `OPENCLAW_GIT_DIR`),
  opdaterer det og installerer den globale CLI fra dette checkout.
- `stable`/`beta` installerer fra npm ved brug af det matchende dist-tag.

Tip: Hvis du vil have stable + dev parallelt, så behold to kloner og peg din gateway på den stabile.

## Plugins og kanaler

Når du skifter kanal med `openclaw update`, synkroniserer OpenClaw også plugin-kilder:

- `dev` foretrækker bundtede plugins fra git-checkout.
- `stable` og `beta` gendanner npm-installerede plugin-pakker.

## Bedste praksis for tagging

- Tag releases, som du vil have git-checkouts til at lande på (`vYYYY.M.D` eller `vYYYY.M.D-<patch>`).
- Hold tags uforanderlige: flyt eller genbrug aldrig et tag.
- npm dist-tags forbliver sandhedskilden for npm-installationer:
  - `latest` → stable
  - `beta` → kandidat-build
  - `dev` → main-snapshot (valgfrit)

## Tilgængelighed af macOS-app

Beta og dev builds kan **ikke** indeholde en macOS app release. Det Er OK:

- Git-tagget og npm dist-tagget kan stadig udgives.
- Angiv “ingen macOS-build for denne beta” i release notes eller changelog.
