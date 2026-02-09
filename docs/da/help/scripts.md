---
summary: "Repository-scripts: formål, omfang og sikkerhedsnoter"
read_when:
  - Kørsel af scripts fra repoet
  - Tilføjelse eller ændring af scripts under ./scripts
title: "Scripts"
---

# Scripts

Mappen `scripts/` indeholder hjælpere scripts til lokale arbejdsgange og ops opgaver.
Brug disse når en opgave er klart bundet til et script; ellers foretrækker CLI.

## Konventioner

- Scripts er **valgfri**, medmindre de er nævnt i dokumentation eller release-checklister.
- Foretræk CLI-overflader, når de findes (eksempel: overvågning af autentificering bruger `openclaw models status --check`).
- Antag, at scripts er værtspecifikke; læs dem, før du kører dem på en ny maskine.

## Scripts til overvågning af autentificering

Scripts til overvågning af autentificering er dokumenteret her:
[/automation/auth-monitoring](/automation/auth-monitoring)

## Når du tilføjer scripts

- Hold scripts fokuserede og dokumenterede.
- Tilføj en kort indgang i den relevante dokumentation (eller opret en, hvis den mangler).
