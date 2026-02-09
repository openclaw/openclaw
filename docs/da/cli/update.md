---
summary: "CLI-reference for `openclaw update` (sikker-ish kildeopdatering + automatisk genstart af gateway)"
read_when:
  - Du vil opdatere et kilde-checkout sikkert
  - Du har brug for at forstå forkortelsesadfærden for `--update`
title: "opdatering"
---

# `openclaw update`

Opdater OpenClaw sikkert og skift mellem stable/beta/dev-kanaler.

Hvis du installerede via **npm/pnpm** (global installation, ingen git-metadata), sker opdateringer via pakkehåndterer-flowet i [Updating](/install/updating).

## Usage

```bash
openclaw update
openclaw update status
openclaw update wizard
openclaw update --channel beta
openclaw update --channel dev
openclaw update --tag beta
openclaw update --no-restart
openclaw update --json
openclaw --update
```

## Options

- `--no-restart`: spring genstart af Gateway-tjenesten over efter en vellykket opdatering.
- `--channel <stable|beta|dev>`: angiv opdateringskanalen (git + npm; gemmes i konfigurationen).
- `--tag <dist-tag|version>`: tilsidesæt npm dist-tag eller version kun for denne opdatering.
- `--json`: udskriv maskinlæsbar `UpdateRunResult` JSON.
- `--timeout <seconds>`: timeout pr. trin (standard er 1200s).

Bemærk: nedgraderinger kræver bekræftelse, fordi ældre versioner kan ødelægge konfigurationen.

## `update status`

Vis den aktive opdateringskanal + git-tag/branch/SHA (for kilde-checkouts) samt opdateringstilgængelighed.

```bash
openclaw update status
openclaw update status --json
openclaw update status --timeout 10
```

Options:

- `--json`: udskriv maskinlæsbar status-JSON.
- `--timeout <seconds>`: timeout for kontroller (standard er 3s).

## `update wizard`

Interaktiv flow for at vælge en opdateringskanal og bekræfte, om Gateway
skal genstartes efter opdatering (standard er at genstarte). Hvis du vælger `dev` uden en git checkout, det
tilbyder at oprette en.

## What it does

Når du skifter kanal eksplicit (`--channel ...`), holder OpenClaw også
installationsmetoden på linje:

- `dev` → sikrer et git-checkout (standard: `~/openclaw`, tilsidesæt med `OPENCLAW_GIT_DIR`),
  opdaterer det og installerer den globale CLI fra dette checkout.
- `stable`/`beta` → installerer fra npm med det matchende dist-tag.

## Git checkout flow

Kanaler:

- `stable`: checkout af det seneste ikke-beta-tag, derefter build + doctor.
- `beta`: checkout af det seneste `-beta`-tag, derefter build + doctor.
- `dev`: checkout af `main`, derefter fetch + rebase.

Overordnet:

1. Kræver et rent worktree (ingen ikke-committede ændringer).
2. Skifter til den valgte kanal (tag eller branch).
3. Henter upstream (kun dev).
4. Kun dev: preflight lint + TypeScript-build i et midlertidigt worktree; hvis spidsen fejler, går den tilbage op til 10 commits for at finde det nyeste rene build.
5. Rebases oven på det valgte commit (kun dev).
6. Installerer afhængigheder (pnpm foretrækkes; npm som fallback).
7. Bygger + bygger Control UI.
8. Kører `openclaw doctor` som den endelige “sikre opdatering”-kontrol.
9. Synkroniserer plugins til den aktive kanal (dev bruger bundtede extensions; stable/beta bruger npm) og opdaterer npm-installerede plugins.

## `--update` shorthand

`openclaw --update` omskrives til `openclaw update` (nyttigt for shells og launcher-scripts).

## See also

- `openclaw doctor` (tilbyder at køre opdatering først på git-checkouts)
- [Development channels](/install/development-channels)
- [Updating](/install/updating)
- [CLI reference](/cli)
