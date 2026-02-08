---
summary: "Repository-scripts: formål, omfang og sikkerhedsnoter"
read_when:
  - Kørsel af scripts fra repoet
  - Tilføjelse eller ændring af scripts under ./scripts
title: "Scripts"
x-i18n:
  source_path: help/scripts.md
  source_hash: efd220df28f20b33
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:13Z
---

# Scripts

Mappen `scripts/` indeholder hjælpescripts til lokale workflows og driftsopgaver.
Brug disse, når en opgave er tydeligt knyttet til et script; ellers bør du foretrække CLI’en.

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
