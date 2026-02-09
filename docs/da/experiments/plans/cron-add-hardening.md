---
summary: "Hærdning af cron.add-inputhåndtering, tilpasning af skemaer og forbedring af cron UI/agent-værktøjer"
owner: "openclaw"
status: "complete"
last_updated: "2026-01-05"
title: "Hærdning af Cron Add"
---

# Hærdning af Cron Add & Skema-tilpasning

## Kontekst

Seneste gateway logs viser gentagne `cron.add` fejl med ugyldige parametre (manglende `sessionTarget`, `wakeMode`, `nyttelast`, og misdannet `tidsplan`). Dette indikerer, at mindst en klient (sandsynligvis agenten værktøj call sti) sender indpakket eller delvist angivne job nyttelast. Separat er der drift mellem cron udbyder optællinger i TypeScript, gateway skema, CLI flag og UI form typer, plus en UI mismatch for `cron. tatus` (forventer `jobCount` mens gateway returnerer `jobs`).

## Mål

- Stop `cron.add` INVALID_REQUEST-spam ved at normalisere almindelige wrapper-payloads og udlede manglende `kind`-felter.
- Tilpasse lister over cron-udbydere på tværs af gateway-skema, cron-typer, CLI-dokumentation og UI-formularer.
- Gøre agentens cron-værktøjsskema eksplicit, så LLM’en producerer korrekte job-payloads.
- Rette visningen af jobantal for cron-status i Control UI.
- Tilføje tests, der dækker normalisering og værktøjsadfærd.

## Ikke-mål

- Ændre cron-planlægningssemantik eller job-udførelsesadfærd.
- Tilføje nye planlægningstyper eller parsing af cron-udtryk.
- Ombygge UI/UX for cron ud over de nødvendige feltrettelser.

## Fund (nuværende huller)

- `CronPayloadSchema` i gateway udelukker `signal` + `imessage`, mens TS-typer inkluderer dem.
- Control UI CronStatus forventer `jobCount`, men gateway returnerer `jobs`.
- Agentens cron-værktøjsskema tillader vilkårlige `job`-objekter, hvilket muliggør fejlagtige input.
- Gateway validerer `cron.add` strengt uden normalisering, så indpakkede payloads fejler.

## Hvad er ændret

- `cron.add` og `cron.update` normaliserer nu almindelige wrapper-former og udleder manglende `kind`-felter.
- Agentens cron-værktøjsskema matcher gateway-skemaet, hvilket reducerer ugyldige payloads.
- Udbyder-enums er tilpasset på tværs af gateway, CLI, UI og macOS-vælger.
- Control UI bruger gateway’ens `jobs`-tællefelt til status.

## Nuværende adfærd

- **Normalisering:** indpakkede `data`/`job`-payloads pakkes ud; `schedule.kind` og `payload.kind` udledes, når det er sikkert.
- **Standarder:** sikre standardværdier anvendes for `wakeMode` og `sessionTarget`, når de mangler.
- **Udbydere:** Discord/Slack/Signal/iMessage vises nu konsekvent på tværs af CLI/UI.

Se [Cron jobs](/automation/cron-jobs) for den normaliserede form og eksempler.

## Verifikation

- Overvåg gateway-logs for reducerede `cron.add` INVALID_REQUEST-fejl.
- Bekræft, at Control UI’s cron-status viser jobantal efter opdatering.

## Valgfrie opfølgninger

- Manuel Control UI-smoke: tilføj et cron-job pr. udbyder + verificér status-jobantal.

## Åbne spørgsmål

- Bør `cron.add` acceptere eksplicit `state` fra klienter (i øjeblikket ikke tilladt af skemaet)?
- Bør vi tillade `webchat` som en eksplicit leveringsudbyder (i øjeblikket filtreret i leveringsopløsningen)?
