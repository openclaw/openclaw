---
summary: "Richtlijnsyntax voor /think + /verbose en hoe deze de redenering van het model beïnvloeden"
read_when:
  - Het aanpassen van parsing of standaardwaarden voor thinking- of verbose-richtlijnen
title: "Thinking-niveaus"
---

# Thinking-niveaus (/think-richtlijnen)

## Wat het doet

- Inline-richtlijn in elke inkomende body: `/t <level>`, `/think:<level>` of `/thinking <level>`.
- Niveaus (aliassen): `off | minimal | low | medium | high | xhigh` (alleen GPT-5.2 + Codex-modellen)
  - minimal → “think”
  - low → “think hard”
  - medium → “think harder”
  - high → “ultrathink” (maximale budget)
  - xhigh → “ultrathink+” (alleen GPT-5.2 + Codex-modellen)
  - `x-high`, `x_high`, `extra-high`, `extra high` en `extra_high` worden gemapt naar `xhigh`.
  - `highest`, `max` worden gemapt naar `high`.
- Provider-notities:
  - Z.AI (`zai/*`) ondersteunt alleen binaire thinking (`on`/`off`). Elk niet-`off` niveau wordt behandeld als `on` (gemapt naar `low`).

## Resolutievolgorde

1. Inline-richtlijn op het bericht (geldt alleen voor dat bericht).
2. Sessie-override (ingesteld door een bericht met alleen een richtlijn te sturen).
3. Globale standaard (`agents.defaults.thinkingDefault` in config).
4. Terugval: low voor modellen die kunnen redeneren; anders off.

## Een sessiestandaard instellen

- Stuur een bericht dat **alleen** de richtlijn bevat (witruimte toegestaan), bijv. `/think:medium` of `/t high`.
- Dit blijft gelden voor de huidige sessie (standaard per afzender); gewist door `/think:off` of een sessie-idle reset.
- Er wordt een bevestigingsantwoord gestuurd (`Thinking level set to high.` / `Thinking disabled.`). Als het niveau ongeldig is (bijv. `/thinking big`), wordt de opdracht geweigerd met een hint en blijft de sessiestatus ongewijzigd.
- Stuur `/think` (of `/think:`) zonder argument om het huidige thinking-niveau te zien.

## Toepassing per agent

- **Embedded Pi**: het opgeloste niveau wordt doorgegeven aan de in-process Pi agent-runtime.

## Verbose-richtlijnen (/verbose of /v)

- Niveaus: `on` (minimal) | `full` | `off` (standaard).
- Een bericht met alleen de richtlijn schakelt sessie-verbose in/uit en antwoordt met `Verbose logging enabled.` / `Verbose logging disabled.`; ongeldige niveaus geven een hint terug zonder de status te wijzigen.
- `/verbose off` slaat een expliciete sessie-override op; wis deze via de Sessions UI door `inherit` te kiezen.
- Inline-richtlijn beïnvloedt alleen dat bericht; anders gelden sessie-/globale standaarden.
- Stuur `/verbose` (of `/verbose:`) zonder argument om het huidige verbose-niveau te zien.
- Wanneer verbose aan staat, sturen agents die gestructureerde toolresultaten uitsturen (Pi, andere JSON-agents) elke toolcall terug als een eigen metadata-only bericht, waar mogelijk voorafgegaan door `<emoji> <tool-name>: <arg>` (pad/commando). Deze toolsamenvattingen worden verzonden zodra elke tool start (aparte bubbels), niet als streaming-delta’s.
- Wanneer verbose `full` is, worden tooluitvoeren ook na voltooiing doorgestuurd (aparte bubbel, afgekapt tot een veilige lengte). Als je `/verbose on|full|off` toggelt terwijl een run bezig is, respecteren daaropvolgende toolbubbels de nieuwe instelling.

## Zichtbaarheid van redenering (/reasoning)

- Niveaus: `on|off|stream`.
- Een bericht met alleen de richtlijn schakelt of thinking-blokken in antwoorden worden getoond.
- Wanneer ingeschakeld, wordt de redenering verzonden als een **apart bericht** voorafgegaan door `Reasoning:`.
- `stream` (alleen Telegram): streamt redenering in de Telegram-conceptbubbel terwijl het antwoord wordt gegenereerd en stuurt daarna het definitieve antwoord zonder redenering.
- Alias: `/reason`.
- Stuur `/reasoning` (of `/reasoning:`) zonder argument om het huidige redeneringsniveau te zien.

## Gerelateerd

- Documentatie voor Elevated mode staat in [Elevated mode](/tools/elevated).

## Heartbeats

- De heartbeat-probebody is de geconfigureerde heartbeat-prompt (standaard: `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`). Inline-richtlijnen in een heartbeat-bericht gelden zoals gebruikelijk (maar vermijd het wijzigen van sessiestandaarden via heartbeats).
- Heartbeat-levering verzendt standaard alleen de eindpayload. Om ook het aparte `Reasoning:`-bericht te verzenden (wanneer beschikbaar), stel `agents.defaults.heartbeat.includeReasoning: true` in of per agent `agents.list[].heartbeat.includeReasoning: true`.

## Webchat-UI

- De thinking-selector in de webchat weerspiegelt bij het laden van de pagina het in de sessie opgeslagen niveau uit de inkomende session store/config.
- Een ander niveau kiezen geldt alleen voor het volgende bericht (`thinkingOnce`); na verzenden springt de selector terug naar het opgeslagen sessieniveau.
- Om de sessiestandaard te wijzigen, stuur een `/think:<level>`-richtlijn (zoals hiervoor); de selector zal dit na de volgende herlaadbeurt weergeven.
