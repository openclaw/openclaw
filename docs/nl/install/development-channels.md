---
summary: "Stable, beta- en dev-kanalen: semantiek, wisselen en taggen"
read_when:
  - Je wilt wisselen tussen stable/beta/dev
  - Je bent prereleases aan het taggen of publiceren
title: "Ontwikkelkanalen"
---

# Ontwikkelkanalen

Laatst bijgewerkt: 2026-01-21

OpenClaw levert drie updatekanalen:

- **stable**: npm dist-tag `latest`.
- **beta**: npm dist-tag `beta` (builds in test).
- **dev**: voortschrijdende head van `main` (git). npm dist-tag: `dev` (wanneer gepubliceerd).

We leveren builds aan **beta**, testen ze en **promoveren vervolgens een gevalideerde build naar `latest`**
zonder het versienummer te wijzigen — dist-tags zijn de bron van waarheid voor npm-installaties.

## Wisselen tussen kanalen

Git-checkout:

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

- `stable`/`beta` checkt de meest recente overeenkomende tag uit (vaak dezelfde tag).
- `dev` schakelt over naar `main` en rebased op de upstream.

npm/pnpm globale installatie:

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

Dit werkt bij via de bijbehorende npm dist-tag (`latest`, `beta`, `dev`).

Wanneer je **expliciet** van kanaal wisselt met `--channel`, lijnt OpenClaw ook
de installatiemethode uit:

- `dev` zorgt voor een git-checkout (standaard `~/openclaw`, te overschrijven met `OPENCLAW_GIT_DIR`),
  werkt deze bij en installeert de globale CLI vanuit die checkout.
- `stable`/`beta` installeert vanaf npm met de bijpassende dist-tag.

Tip: als je stable + dev parallel wilt gebruiken, houd twee clones aan en laat je Gateway naar de stabiele wijzen.

## Plugins en kanalen

Wanneer je van kanaal wisselt met `openclaw update`, synchroniseert OpenClaw ook pluginbronnen:

- `dev` geeft de voorkeur aan gebundelde plugins uit de git-checkout.
- `stable` en `beta` herstellen via npm geïnstalleerde pluginpakketten.

## Best practices voor taggen

- Tag releases waarop git-checkouts moeten uitkomen (`vYYYY.M.D` of `vYYYY.M.D-<patch>`).
- Houd tags immutabel: verplaats of hergebruik een tag nooit.
- npm dist-tags blijven de bron van waarheid voor npm-installaties:
  - `latest` → stable
  - `beta` → kandidaat-build
  - `dev` → main-snapshot (optioneel)

## Beschikbaarheid van de macOS-app

Beta- en dev-builds bevatten mogelijk **geen** macOS-apprelease. Dat is oké:

- De git-tag en npm dist-tag kunnen nog steeds worden gepubliceerd.
- Vermeld “geen macOS-build voor deze beta” in release-opmerkingen of de changelog.
