---
summary: "Stabila, beta- och dev-kanaler: semantik, växling och taggning"
read_when:
  - Du vill växla mellan stable/beta/dev
  - Du taggar eller publicerar prereleaser
title: "Utvecklingskanaler"
---

# Utvecklingskanaler

Senast uppdaterad: 2026-01-21

OpenClaw levererar tre uppdateringskanaler:

- **stable**: npm dist-tag `latest`.
- **beta**: npm dist-tag `beta` (byggen under test).
- **dev**: flytta huvud på `main` (git). npm dist-tag: `dev` (vid publicering).

Vi levererar byggen till **beta**, testar dem och **befordrar sedan ett verifierat bygge till `latest`**
utan att ändra versionsnumret — dist-tags är sanningskällan för npm-installationer.

## Växla kanaler

Git-checkout:

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

- `stable`/`beta` checkar ut den senaste matchande taggen (ofta samma tagg).
- `dev` växlar till `main` och rebaserar på upstream.

Global installation med npm/pnpm:

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

Detta uppdaterar via motsvarande npm dist-tag (`latest`, `beta`, `dev`).

När du **uttryckligen** växlar kanal med `--channel` anpassar OpenClaw även
installationsmetoden:

- `dev` säkerställer en git-checkout (standard `~/openclaw`, åsidosätt med `OPENCLAW_GIT_DIR`),
  uppdaterar den och installerar den globala CLI:n från den checkouten.
- `stable`/`beta` installerar från npm med matchande dist-tag.

Tips: om du vill ha stable + dev parallellt, behåll två kloner och peka din gateway mot den stabila.

## Pluginer och kanaler

När du växlar kanal med `openclaw update` synkar OpenClaw även plugin-källor:

- `dev` föredrar medföljande pluginer från git-checkouten.
- `stable` och `beta` återställer npm-installerade plugin-paket.

## Bästa praxis för taggning

- Tagga releaser som du vill att git-checkouts ska landa på (`vYYYY.M.D` eller `vYYYY.M.D-<patch>`).
- Håll taggar immutabla: flytta eller återanvänd aldrig en tagg.
- npm dist-tags förblir sanningskällan för npm-installationer:
  - `latest` → stable
  - `beta` → kandidatbygge
  - `dev` → huvudsnapshot (valfritt)

## Tillgänglighet för macOS-appen

Beta- och dev-versioner får **inte** innehålla en macOS-app-utgåva. Det är okej:

- Git-taggen och npm dist-taggen kan fortfarande publiceras.
- Ange “ingen macOS-version för denna beta” i release notes eller changelog.
