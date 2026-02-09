---
summary: "Verhoogde exec-modus en /elevated-directieven"
read_when:
  - Aanpassen van standaardinstellingen voor verhoogde modus, toegestane lijsten of gedrag van slash-opdrachten
title: "Verhoogde modus"
---

# Verhoogde modus (/elevated-directieven)

## Wat het doet

- `/elevated on` draait op de Gateway-host en behoudt uitvoeringsgoedkeuringen (hetzelfde als `/elevated ask`).
- `/elevated full` draait op de Gateway-host **en** keurt exec automatisch goed (slaat uitvoeringsgoedkeuringen over).
- `/elevated ask` draait op de Gateway-host maar behoudt uitvoeringsgoedkeuringen (hetzelfde als `/elevated on`).
- `on`/`ask` forceren **geen** `exec.security=full`; het geconfigureerde beveiligings-/vraagbeleid blijft van toepassing.
- Wijzigt alleen het gedrag wanneer de agent **gesandboxed** is (anders draait exec al op de host).
- Directiefvormen: `/elevated on|off|ask|full`, `/elev on|off|ask|full`.
- Alleen `on|off|ask|full` worden geaccepteerd; al het andere retourneert een hint en wijzigt de status niet.

## Wat het regelt (en wat niet)

- **Beschikbaarheidsdrempels**: `tools.elevated` is de globale basislijn. `agents.list[].tools.elevated` kan verhoogd per agent verder beperken (beide moeten toestaan).
- **Per-sessiestatus**: `/elevated on|off|ask|full` stelt het verhoogde niveau in voor de huidige sessiesleutel.
- **Inline-directief**: `/elevated on|ask|full` binnen een bericht geldt alleen voor dat bericht.
- **Groepen**: In groepschats worden verhoogde directieven alleen gehonoreerd wanneer de agent wordt genoemd. Alleen-opdrachtberichten die vermeldingseisen omzeilen, worden behandeld als genoemd.
- **Host-uitvoering**: verhoogd forceert `exec` naar de Gateway-host; `full` stelt ook `security=full` in.
- **Goedkeuringen**: `full` slaat uitvoeringsgoedkeuringen over; `on`/`ask` respecteren ze wanneer regels voor toegestane lijst/vraag dit vereisen.
- **Niet-gesandboxde agents**: geen effect op locatie; beïnvloedt alleen gating, logging en status.
- **Toolbeleid blijft gelden**: als `exec` door het toolbeleid wordt geweigerd, kan verhoogd niet worden gebruikt.
- **Los van `/exec`**: `/exec` past per-sessiestandaarden aan voor geautoriseerde afzenders en vereist geen verhoogde modus.

## Resolutievolgorde

1. Inline-directief in het bericht (geldt alleen voor dat bericht).
2. Sessie-override (ingesteld door een bericht met alleen de directief te verzenden).
3. Globale standaard (`agents.defaults.elevatedDefault` in de config).

## Een sessiestandaard instellen

- Stuur een bericht dat **alleen** de directief bevat (witruimte toegestaan), bijv. `/elevated full`.
- Er wordt een bevestigingsantwoord verzonden (`Elevated mode set to full...` / `Elevated mode disabled.`).
- Als verhoogde toegang is uitgeschakeld of de afzender niet op de goedgekeurde toegestane lijst staat, antwoordt de directief met een actiegerichte fout en wijzigt de sessiestatus niet.
- Stuur `/elevated` (of `/elevated:`) zonder argument om het huidige verhoogde niveau te zien.

## Beschikbaarheid + toegestane lijsten

- Functiedrempel: `tools.elevated.enabled` (standaard kan uit staan via config, zelfs als de code het ondersteunt).
- Afzender-toegestane lijst: `tools.elevated.allowFrom` met per-provider toegestane lijsten (bijv. `discord`, `whatsapp`).
- Per-agentdrempel: `agents.list[].tools.elevated.enabled` (optioneel; kan alleen verder beperken).
- Per-agent toegestane lijst: `agents.list[].tools.elevated.allowFrom` (optioneel; indien ingesteld moet de afzender overeenkomen met **zowel** de globale als de per-agent toegestane lijst).
- Discord-terugval: als `tools.elevated.allowFrom.discord` wordt weggelaten, wordt de lijst `channels.discord.dm.allowFrom` als terugval gebruikt. Stel `tools.elevated.allowFrom.discord` in (zelfs `[]`) om te overschrijven. Per-agent toegestane lijsten gebruiken de terugval **niet**.
- Alle drempels moeten slagen; anders wordt verhoogd als niet beschikbaar behandeld.

## Logging + status

- Verhoogde exec-aanroepen worden gelogd op info-niveau.
- Sessiestatus bevat de verhoogde modus (bijv. `elevated=ask`, `elevated=full`).
