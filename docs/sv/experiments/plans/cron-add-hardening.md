---
summary: "Härda indatahanteringen för cron.add, anpassa scheman och förbättra cron-UI/agentverktyg"
owner: "openclaw"
status: "complete"
last_updated: "2026-01-05"
title: "Härdning av Cron Add"
---

# Härdning av Cron Add & schemaanpassning

## Kontext

Senaste gateway-loggar visar upprepade `cron.add` misslyckanden med ogiltiga parametrar (saknar `sessionTarget`, `wakeMode`, `payload` och felaktigt formatterad `schedule`). Detta tyder på att minst en klient (sannolikt agenten verktyg samtal sökväg) skickar insvept eller delvis angivna jobb nyttolaster. Separat finns det drift mellan cron-leverantörens enums i TypeScript, gateway-schema, CLI-flaggor och UI-formulärtyper, plus en UI-obalans för `cron. tatus` (förväntar sig `jobCount` medan gateway returnerar `job`).

## Mål

- Stoppa `cron.add` INVALID_REQUEST-spam genom att normalisera vanliga wrapper-payloads och härleda saknade `kind`-fält.
- Anpassa listor över cron-leverantörer mellan gatewayschema, cron-typer, CLI-dokumentation och UI-formulär.
- Göra agentens cron-verktygsschema explicit så att LLM:en producerar korrekta jobbpayloads.
- Fixa visningen av antal jobb i Control UI:s cron-status.
- Lägga till tester som täcker normalisering och verktygsbeteende.

## Icke-mål

- Ändra semantik för cron-schemaläggning eller jobbkörningsbeteende.
- Lägga till nya schematyper eller parsning av cron-uttryck.
- Göra om UI/UX för cron utöver nödvändiga fältfixar.

## Iakttagelser (nuvarande brister)

- `CronPayloadSchema` i gateway utesluter `signal` + `imessage`, medan TS-typer inkluderar dem.
- Control UI CronStatus förväntar `jobCount`, men gateway returnerar `jobs`.
- Agentens cron-verktygsschema tillåter godtyckliga `job`-objekt, vilket möjliggör felaktiga indata.
- Gateway validerar `cron.add` strikt utan normalisering, så inbäddade payloads misslyckas.

## Vad som ändrades

- `cron.add` och `cron.update` normaliserar nu vanliga wrapper-former och härleder saknade `kind`-fält.
- Agentens cron-verktygsschema matchar gatewayschemat, vilket minskar ogiltiga payloads.
- Leverantörsenum är anpassade mellan gateway, CLI, UI och macOS-väljare.
- Control UI använder gatewayns fält `jobs` för status.

## Nuvarande beteende

- **Normalisering:** inbäddade `data`/`job`-payloads packas upp; `schedule.kind` och `payload.kind` härleds när det är säkert.
- **Standardvärden:** säkra standardvärden tillämpas för `wakeMode` och `sessionTarget` när de saknas.
- **Leverantörer:** Discord/Slack/Signal/iMessage exponeras nu konsekvent i CLI/UI.

Se [Cron jobs](/automation/cron-jobs) för den normaliserade formen och exempel.

## Verifiering

- Övervaka gateway-loggar för minskade `cron.add` INVALID_REQUEST-fel.
- Bekräfta att Control UI:s cron-status visar antal jobb efter uppdatering.

## Valfria uppföljningar

- Manuell Control UI-smoke: lägg till ett cron-jobb per leverantör och verifiera statusens jobbräkning.

## Öppna frågor

- Bör `cron.add` acceptera explicit `state` från klienter (för närvarande tillåts inte av schemat)?
- Bör vi tillåta `webchat` som explicit leveransleverantör (för närvarande filtreras den bort i leveransupplösningen)?
