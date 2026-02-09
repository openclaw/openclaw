---
summary: "Statuslogica van de menubalk en wat aan gebruikers wordt getoond"
read_when:
  - Afstellen van de mac-menubalk-UI of statuslogica
title: "Menubalk"
---

# Statuslogica van de menubalk

## Wat wordt getoond

- We tonen de huidige werkstatus van de agent in het menubalkpictogram en in de eerste statusregel van het menu.
- De gezondheidsstatus is verborgen terwijl werk actief is; deze keert terug wanneer alle sessies inactief zijn.
- Het blok “Nodes” in het menu toont alleen **apparaten** (gekoppelde nodes via `node.list`), geen client-/presence‑items.
- Een sectie “Usage” verschijnt onder Context wanneer snapshots van providergebruik beschikbaar zijn.

## Statusmodel

- Sessies: events komen binnen met `runId` (per run) plus `sessionKey` in de payload. De “hoofd”-sessie is de sleutel `main`; als die ontbreekt, vallen we terug op de meest recent bijgewerkte sessie.
- Prioriteit: hoofd wint altijd. Als de hoofd-sessie actief is, wordt die status direct getoond. Als de hoofd-sessie inactief is, wordt de meest recent actieve niet-hoofd-sessie getoond. We wisselen niet midden in een activiteit; we schakelen alleen wanneer de huidige sessie inactief wordt of de hoofd-sessie actief wordt.
- Activiteitstypen:
  - `job`: uitvoering van opdrachten op hoog niveau (`state: started|streaming|done|error`).
  - `tool`: `phase: start|result` met `toolName` en `meta/args`.

## IconState enum (Swift)

- `idle`
- `workingMain(ActivityKind)`
- `workingOther(ActivityKind)`
- `overridden(ActivityKind)` (debug-override)

### ActivityKind → glyph

- `exec` → 💻
- `read` → 📄
- `write` → ✍️
- `edit` → 📝
- `attach` → 📎
- standaard → 🛠️

### Visuele mapping

- `idle`: normale critter.
- `workingMain`: badge met glyph, volledige tint, “werkende” pootanimatie.
- `workingOther`: badge met glyph, gedempte tint, geen gescharrel.
- `overridden`: gebruikt de gekozen glyph/tint ongeacht de activiteit.

## Tekst van statusregel (menu)

- Terwijl werk actief is: `<Session role> · <activity label>`
  - Voorbeelden: `Main · exec: pnpm test`, `Other · read: apps/macos/Sources/OpenClaw/AppState.swift`.
- Wanneer inactief: valt terug op de gezondheidssamenvatting.

## Eventverwerking

- Bron: control‑channel `agent`-events (`ControlChannel.handleAgentEvent`).
- Geparseerde velden:
  - `stream: "job"` met `data.state` voor start/stop.
  - `stream: "tool"` met `data.phase`, `name`, optioneel `meta`/`args`.
- Labels:
  - `exec`: eerste regel van `args.command`.
  - `read`/`write`: verkort pad.
  - `edit`: pad plus afgeleid wijzigingstype uit `meta`/diff‑aantallen.
  - fallback: toolnaam.

## Debug-overide

- Instellingen ▸ Debug ▸ kiezer “Icon override”:
  - `System (auto)` (standaard)
  - `Working: main` (per tooltype)
  - `Working: other` (per tooltype)
  - `Idle`
- Opgeslagen via `@AppStorage("iconOverride")`; gemapt naar `IconState.overridden`.

## Testchecklist

- Start een hoofd-sessietaak: verifieer dat het pictogram direct wisselt en de statusregel het hoofdlabel toont.
- Start een niet-hoofd-sessietaak terwijl de hoofd-sessie inactief is: pictogram/status toont niet-hoofd; blijft stabiel tot deze klaar is.
- Start hoofd terwijl een andere actief is: pictogram schakelt direct naar hoofd.
- Snelle toolbursts: zorg dat de badge niet flikkert (TTL-speling op toolresultaten).
- Gezondheidsregel verschijnt opnieuw zodra alle sessies inactief zijn.
