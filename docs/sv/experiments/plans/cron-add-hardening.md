---
summary: "Härda indatahanteringen för cron.add, anpassa scheman och förbättra cron-UI/agentverktyg"
owner: "openclaw"
status: "complete"
last_updated: "2026-01-05"
title: "Härdning av Cron Add"
x-i18n:
  source_path: experiments/plans/cron-add-hardening.md
  source_hash: d7e469674bd9435b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:17:14Z
---

# Härdning av Cron Add & schemaanpassning

## Kontext

Nya gateway-loggar visar upprepade `cron.add`-fel med ogiltiga parametrar (saknar `sessionTarget`, `wakeMode`, `payload` och felaktigt formaterad `schedule`). Detta indikerar att minst en klient (troligen agentens verktygsanropsväg) skickar inbäddade eller delvis specificerade jobbpayloads. Separat finns det avvikelser mellan cron-leverantörsenumerationer i TypeScript, gatewayschemat, CLI-flaggor och UI-formulärtyper, samt en UI-mismatch för `cron.status` (förväntar `jobCount` medan gateway returnerar `jobs`).

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
