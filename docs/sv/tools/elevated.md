---
summary: "Elevated exec-läge och /elevated-direktiv"
read_when:
  - Justerar standardvärden för elevated-läge, tillåtelselistor eller beteende för snedstreckskommandon
title: "Elevated-läge"
---

# Elevated-läge (/elevated-direktiv)

## Vad det gör

- `/elevated on` körs på gateway-värden och behåller exec-godkännanden (samma som `/elevated ask`).
- `/elevated full` körs på gateway-värden **och** auto-godkänner exec (hoppar över exec-godkännanden).
- `/elevated ask` körs på gateway-värden men behåller exec-godkännanden (samma som `/elevated on`).
- `on`/`ask` tvingar **inte** `exec.security=full`; konfigurerad säkerhets-/frågepolicy gäller fortfarande.
- Ändrar endast beteende när agenten är **sandboxed** (annars körs exec redan på värden).
- Direktiformer: `/elevated on|off|ask|full`, `/elev on|off|ask|full`.
- Endast `on|off|ask|full` accepteras; allt annat returnerar en hint och ändrar inte tillstånd.

## Vad det styr (och vad det inte gör)

- **Tillgänglighetsportar**: `tools.elevated` är den globala baslinjen. `agents.list[].tools.elevated` kan ytterligare begränsa förhöjd per agent (båda måste tillåta).
- **Per-sessionstillstånd**: `/elevated on|off|ask|full` sätter elevated-nivån för den aktuella sessionsnyckeln.
- **Inline-direktiv**: `/elevated on|ask|full` i ett meddelande gäller endast för det meddelandet.
- **Grupper**: I gruppchattar hedras förhöjda direktiv endast när agenten nämns. Kommandon endast meddelanden som kringgår nämna krav behandlas som nämnts.
- **Körning på värd**: elevated tvingar `exec` till gateway-värden; `full` sätter även `security=full`.
- **Godkännanden**: `full` hoppar över exec-godkännanden; `on`/`ask` respekterar dem när tillåtelselista-/frågeregler kräver det.
- **Ej sandboxade agenter**: no-op för plats; påverkar endast grindar, loggning och status.
- **Verktygspolicy gäller fortfarande**: om `exec` nekas av verktygspolicyn kan elevated inte användas.
- **Separat från `/exec`**: `/exec` justerar per-sessionstandarder för auktoriserade avsändare och kräver inte elevated.

## Upplösningsordning

1. Inline-direktiv i meddelandet (gäller endast för det meddelandet).
2. Sessionsöverskrivning (satt genom att skicka ett meddelande som endast innehåller direktivet).
3. Global standard (`agents.defaults.elevatedDefault` i konfig).

## Ställa in en sessionsstandard

- Skicka ett meddelande som är **bara** direktivet (blanktecken tillåtet), t.ex. `/förhöjd full`.
- Bekräftelsesvar skickas (`Elevated mode set to full...` / `Elevated mode disabled.`).
- Om elevated-åtkomst är inaktiverad eller avsändaren inte finns på den godkända tillåtelselistan svarar direktivet med ett åtgärdbart fel och ändrar inte sessionsstatus.
- Skicka `/elevated` (eller `/elevated:`) utan argument för att se aktuell elevated-nivå.

## Tillgänglighet + tillåtelselistor

- Funktionsgrind: `tools.elevated.enabled` (standard kan vara av via konfig även om koden stöder det).
- Avsändartillåten lista: `tools.elevated.allowFrom` med per-provider allowlists (t.ex. `discord`, `whatsapp`).
- Per-agent-grind: `agents.list[].tools.elevated.enabled` (valfri; kan endast ytterligare begränsa).
- Per-agent-tillåtelselista: `agents.list[].tools.elevated.allowFrom` (valfri; när den är satt måste avsändaren matcha **både** globala + per-agent-tillåtelselistor).
- Discord fallback: om `tools.elevated.allowFrom.discord` utelämnas `channels.discord.dm.allowFrom`-listan används som en reserv. Ange `tools.elevated.allowFrom.discord` (även `[]`) att åsidosätta. Per-agent allowlists gör **inte** använda reserven.
- Alla grindar måste passera; annars behandlas elevated som otillgängligt.

## Loggning + status

- Elevated exec-anrop loggas på info-nivå.
- Sessionsstatus inkluderar förhöjt läge (t.ex. `elevated=ask`, `elevated=full`).
