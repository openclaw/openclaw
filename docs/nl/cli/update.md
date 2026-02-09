---
summary: "CLI-referentie voor `openclaw update` (veilig-ish bronupdate + automatische herstart van de Gateway)"
read_when:
  - Je wilt een bron-checkout veilig bijwerken
  - Je moet het verkorte gedrag van `--update` begrijpen
title: "update"
---

# `openclaw update`

Werk OpenClaw veilig bij en schakel tussen stable/beta/dev-kanalen.

Als je hebt geïnstalleerd via **npm/pnpm** (globale installatie, geen git-metadata), verlopen updates via de pakketbeheerderstroom in [Updating](/install/updating).

## Gebruik

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

## Opties

- `--no-restart`: sla het herstarten van de Gateway-service over na een geslaagde update.
- `--channel <stable|beta|dev>`: stel het updatekanaal in (git + npm; wordt opgeslagen in de config).
- `--tag <dist-tag|version>`: overschrijf de npm dist-tag of versie alleen voor deze update.
- `--json`: toon machineleesbare `UpdateRunResult` JSON.
- `--timeout <seconds>`: time-out per stap (standaard 1200s).

Let op: downgrades vereisen bevestiging omdat oudere versies de configuratie kunnen breken.

## `update status`

Toon het actieve updatekanaal + git-tag/branch/SHA (voor bron-checkouts), plus updatebeschikbaarheid.

```bash
openclaw update status
openclaw update status --json
openclaw update status --timeout 10
```

Opties:

- `--json`: toon machineleesbare status-JSON.
- `--timeout <seconds>`: time-out voor controles (standaard 3s).

## `update wizard`

Interactieve stroom om een updatekanaal te kiezen en te bevestigen of de Gateway
na het bijwerken moet worden herstart (standaard is herstarten). Als je `dev` selecteert zonder een git-checkout, biedt het aan er een te maken.

## Wat het doet

Wanneer je expliciet van kanaal wisselt (`--channel ...`), houdt OpenClaw ook de
installatiemethode uitgelijnd:

- `dev` → zorgt voor een git-checkout (standaard: `~/openclaw`, te overschrijven met `OPENCLAW_GIT_DIR`),
  werkt deze bij en installeert de globale CLI vanuit die checkout.
- `stable`/`beta` → installeert vanuit npm met de bijbehorende dist-tag.

## Git-checkoutstroom

Kanalen:

- `stable`: checkout de nieuwste niet-beta tag, daarna build + doctor.
- `beta`: checkout de nieuwste `-beta` tag, daarna build + doctor.
- `dev`: checkout `main`, daarna fetch + rebase.

Hoog-niveau:

1. Vereist een schone worktree (geen niet-gecommitte wijzigingen).
2. Schakelt naar het geselecteerde kanaal (tag of branch).
3. Haalt upstream op (alleen dev).
4. Alleen dev: preflight lint + TypeScript-build in een tijdelijke worktree; als de tip faalt, loopt het tot 10 commits terug om de nieuwste schone build te vinden.
5. Rebase op de geselecteerde commit (alleen dev).
6. Installeert dependencies (pnpm heeft voorkeur; npm als fallback).
7. Bouwt + bouwt de Control UI.
8. Draait `openclaw doctor` als laatste “veilige update”-controle.
9. Synchroniseert plugins met het actieve kanaal (dev gebruikt gebundelde extensies; stable/beta gebruikt npm) en werkt npm-geïnstalleerde plugins bij.

## `--update`-verkorting

`openclaw --update` wordt herschreven naar `openclaw update` (handig voor shells en launcherscripts).

## Zie ook

- `openclaw doctor` (biedt aan om eerst update uit te voeren op git-checkouts)
- [Development channels](/install/development-channels)
- [Updating](/install/updating)
- [CLI reference](/cli)
