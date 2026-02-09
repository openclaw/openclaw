---
summary: "macOS Skills-instellingen-UI en status via de Gateway"
read_when:
  - De macOS Skills-instellingen-UI bijwerken
  - Skills-gating of installatiegedrag wijzigen
title: "Skills"
---

# Skills (macOS)

De macOS-app ontsluit OpenClaw Skills via de Gateway; hij parseert Skills niet lokaal.

## Gegevensbron

- `skills.status` (Gateway) retourneert alle Skills plus geschiktheid en ontbrekende vereisten
  (inclusief allowlist-blokkades voor gebundelde Skills).
- Vereisten worden afgeleid van `metadata.openclaw.requires` in elke `SKILL.md`.

## Installatieacties

- `metadata.openclaw.install` definieert installatieopties (brew/node/go/uv).
- De app roept `skills.install` aan om installers uit te voeren op de Gateway-host.
- De Gateway toont slechts één voorkeursinstaller wanneer er meerdere zijn opgegeven
  (brew indien beschikbaar, anders node manager uit `skills.install`, standaard npm).

## Omgevingsvariabelen/API-sleutels

- De app slaat sleutels op in `~/.openclaw/openclaw.json` onder `skills.entries.<skillKey>`.
- `skills.update` past `enabled`, `apiKey` en `env` aan.

## Modus op afstand

- Installatie- en configuratie-updates vinden plaats op de Gateway-host (niet op de lokale Mac).
