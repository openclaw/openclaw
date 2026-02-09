---
summary: "Cron.add-invoerafhandeling verharden, schema’s uitlijnen en cron-UI/agent-tooling verbeteren"
owner: "openclaw"
status: "complete"
last_updated: "2026-01-05"
title: "Cron Add-verharding"
---

# Cron Add-verharding & Schema-uitlijning

## Context

Recente gateway-logs tonen herhaalde `cron.add`-fouten met ongeldige parameters (ontbrekende `sessionTarget`, `wakeMode`, `payload` en een onjuist gevormde `schedule`). Dit geeft aan dat ten minste één client (waarschijnlijk het agent-tool-aanroeppad) ingepakte of gedeeltelijk gespecificeerde job-payloads verstuurt. Daarnaast is er afwijking tussen cron-provider-enums in TypeScript, het gateway-schema, CLI-flags en UI-formuliertypen, plus een UI-mismatch voor `cron.status` (verwacht `jobCount` terwijl de gateway `jobs` retourneert).

## Doelen

- Stop `cron.add` INVALID_REQUEST-spam door veelvoorkomende wrapper-payloads te normaliseren en ontbrekende `kind`-velden af te leiden.
- Cron-providerlijsten uitlijnen over gateway-schema, cron-types, CLI-documentatie en UI-formulieren.
- Het agent-cron-toolschema expliciet maken zodat de LLM correcte job-payloads produceert.
- De weergave van het aantal cron-statusjobs in de Control UI herstellen.
- Tests toevoegen om normalisatie en toolgedrag te dekken.

## Niet-doelen

- Cron-planningssemantiek of job-uitvoeringsgedrag wijzigen.
- Nieuwe planningssoorten toevoegen of cron-expressieparsing wijzigen.
- De UI/UX voor cron herontwerpen buiten de noodzakelijke veldcorrecties.

## Bevindingen (huidige hiaten)

- `CronPayloadSchema` in de gateway sluit `signal` + `imessage` uit, terwijl TS-typen ze bevatten.
- Control UI CronStatus verwacht `jobCount`, maar de gateway retourneert `jobs`.
- Het agent-cron-toolschema staat willekeurige `job`-objecten toe, wat misvormde invoer mogelijk maakt.
- De gateway valideert `cron.add` strikt zonder normalisatie, waardoor ingepakte payloads falen.

## Wat is gewijzigd

- `cron.add` en `cron.update` normaliseren nu veelvoorkomende wrapper-vormen en leiden ontbrekende `kind`-velden af.
- Het agent-cron-toolschema komt overeen met het gateway-schema, wat ongeldige payloads vermindert.
- Provider-enums zijn uitgelijnd over gateway, CLI, UI en macOS-kiezer.
- De Control UI gebruikt het `jobs`-telveld van de gateway voor status.

## Huidig gedrag

- **Normalisatie:** ingepakte `data`/`job`-payloads worden uitgepakt; `schedule.kind` en `payload.kind` worden afgeleid wanneer dat veilig is.
- **Standaardwaarden:** veilige standaardwaarden worden toegepast voor `wakeMode` en `sessionTarget` wanneer ze ontbreken.
- **Providers:** Discord/Slack/Signal/iMessage worden nu consistent getoond in CLI/UI.

Zie [Cron jobs](/automation/cron-jobs) voor de genormaliseerde vorm en voorbeelden.

## Verificatie

- Houd gateway-logs in de gaten voor een afname van `cron.add` INVALID_REQUEST-fouten.
- Bevestig dat de Control UI na verversen het aantal cron-statusjobs toont.

## Optionele vervolgstappen

- Handmatige Control UI-smoketest: voeg per provider een cron-job toe en verifieer het aantal statusjobs.

## Open vragen

- Moet `cron.add` expliciete `state` van clients accepteren (momenteel niet toegestaan door het schema)?
- Moeten we `webchat` toestaan als expliciete delivery provider (momenteel uitgefilterd in delivery resolution)?
