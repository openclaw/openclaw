---
summary: "Berichtenstroom, sessies, wachtrijen en zichtbaarheid van redenering"
read_when:
  - Uitleggen hoe inkomende berichten antwoorden worden
  - Verduidelijken van sessies, wachtrijmodi of streaminggedrag
  - Documenteren van zichtbaarheid van redenering en gebruiksimplicaties
title: "Berichten"
---

# Berichten

Deze pagina brengt samen hoe OpenClaw omgaat met inkomende berichten, sessies, wachtrijen,
streaming en zichtbaarheid van redenering.

## Berichtstroom (hoog niveau)

```
Inbound message
  -> routing/bindings -> session key
  -> queue (if a run is active)
  -> agent run (streaming + tools)
  -> outbound replies (channel limits + chunking)
```

Belangrijke knoppen staan in de configuratie:

- `messages.*` voor prefixen, wachtrijen en groepsgedrag.
- `agents.defaults.*` voor blokstreaming en standaardinstellingen voor chunking.
- Kanaaloverschrijvingen (`channels.whatsapp.*`, `channels.telegram.*`, enz.) voor limieten en streaming-toggles.

Zie [Configuratie](/gateway/configuration) voor het volledige schema.

## Inkomende dedupe

Kanalen kunnen hetzelfde bericht opnieuw afleveren na reconnects. OpenClaw houdt een
kortlevende cache bij, gesleuteld op kanaal/account/peer/sessie/bericht-id, zodat dubbele
afleveringen geen nieuwe agent-run triggeren.

## Inkomende debouncing

Snelle opeenvolgende berichten van **dezelfde afzender** kunnen via `messages.inbound` worden
gebundeld tot één agentbeurt. Debouncing is gescopeerd per kanaal + gesprek
en gebruikt het meest recente bericht voor antwoord-threading/ID's.

Config (globale standaard + per-kanaaloverschrijvingen):

```json5
{
  messages: {
    inbound: {
      debounceMs: 2000,
      byChannel: {
        whatsapp: 5000,
        slack: 1500,
        discord: 1500,
      },
    },
  },
}
```

Notities:

- Debounce is van toepassing op **alleen-tekst** berichten; media/bijlagen worden direct geflusht.
- Besturingsopdrachten omzeilen debouncing zodat ze zelfstandig blijven.

## Sessies en apparaten

Sessies zijn eigendom van de Gateway, niet van clients.

- Directe chats worden samengevoegd in de hoofdsessiesleutel van de agent.
- Groepen/kanalen krijgen hun eigen sessiesleutels.
- De sessieopslag en transcripties leven op de Gateway-host.

Meerdere apparaten/kanalen kunnen aan dezelfde sessie worden gekoppeld, maar de geschiedenis
wordt niet volledig teruggesynchroniseerd naar elke client. Aanbeveling: gebruik één primair
apparaat voor lange gesprekken om uiteenlopende context te voorkomen. De Control UI en TUI
tonen altijd het door de Gateway ondersteunde sessietranscript en zijn daarmee de bron van
waarheid.

Details: [Sessiebeheer](/concepts/session).

## Inkomende bodies en contextgeschiedenis

OpenClaw scheidt de **prompt body** van de **command body**:

- `Body`: prompttekst die naar de agent wordt gestuurd. Dit kan kanaalomslagen en
  optionele geschiedeniswrappers bevatten.
- `CommandBody`: ruwe gebruikerstekst voor directive-/command-parsing.
- `RawBody`: legacy-alias voor `CommandBody` (behouden voor compatibiliteit).

Wanneer een kanaal geschiedenis aanlevert, gebruikt het een gedeelde wrapper:

- `[Chat messages since your last reply - for context]`
- `[Current message - respond to this]`

Voor **niet-directe chats** (groepen/kanalen/rooms) wordt de **huidige berichtbody**
voorafgegaan door het afzenderlabel (dezelfde stijl als gebruikt voor geschiedenisitems). Dit houdt realtime- en wachtrij-/geschiedenisberichten consistent in de agentprompt.

Geschiedenisbuffers zijn **alleen-pending**: ze bevatten groepsberichten die _geen_
run hebben getriggerd (bijvoorbeeld mention-gated berichten) en **sluiten** berichten
uit die al in het sessietranscript staan.

Directive stripping is alleen van toepassing op de **huidige bericht**-sectie zodat de
geschiedenis intact blijft. Kanalen die geschiedenis wrappen, moeten `CommandBody` (of
`RawBody`) instellen op de oorspronkelijke berichttekst en `Body` behouden
als de gecombineerde prompt.
Geschiedenisbuffers zijn configureerbaar via `messages.groupChat.historyLimit`
(globale standaard) en per-kanaaloverschrijvingen zoals `channels.slack.historyLimit` of
`channels.telegram.accounts.<id>.historyLimit` (stel `0` in om uit te schakelen).

## Wachtrij en opvolging

Als er al een run actief is, kunnen inkomende berichten in de wachtrij worden geplaatst,
naar de huidige run worden gestuurd, of worden verzameld voor een vervolgbeurt.

- Configureren via `messages.queue` (en `messages.queue.byChannel`).
- Modi: `interrupt`, `steer`, `followup`, `collect`, plus backlog-varianten.

Details: [Wachtrijen](/concepts/queue).

## Streaming, chunking en batching

Blokstreaming verzendt gedeeltelijke antwoorden terwijl het model tekstblokken produceert.
Chunking respecteert tekstlimieten van kanalen en voorkomt het splitsen van fenced code.

Belangrijke instellingen:

- `agents.defaults.blockStreamingDefault` (`on|off`, standaard uit)
- `agents.defaults.blockStreamingBreak` (`text_end|message_end`)
- `agents.defaults.blockStreamingChunk` (`minChars|maxChars|breakPreference`)
- `agents.defaults.blockStreamingCoalesce` (idle-gebaseerde batching)
- `agents.defaults.humanDelay` (mensachtige pauze tussen blokantwoorden)
- Kanaaloverschrijvingen: `*.blockStreaming` en `*.blockStreamingCoalesce` (niet-Telegram-kanalen vereisen expliciete `*.blockStreaming: true`)

Details: [Streaming + chunking](/concepts/streaming).

## Zichtbaarheid van redenering en tokens

OpenClaw kan modelredenering tonen of verbergen:

- `/reasoning on|off|stream` regelt de zichtbaarheid.
- Redeneringsinhoud telt nog steeds mee voor tokengebruik wanneer deze door het model wordt geproduceerd.
- Telegram ondersteunt het streamen van redenering in de conceptbubbel.

Details: [Thinking + reasoning directives](/tools/thinking) en [Tokengebruik](/reference/token-use).

## Prefixen, threading en antwoorden

Uitgaande berichtopmaak is gecentraliseerd in `messages`:

- `messages.responsePrefix`, `channels.<channel>.responsePrefix` en `channels.<channel>.accounts.<id>.responsePrefix` (cascade voor uitgaande prefixen), plus `channels.whatsapp.messagePrefix` (WhatsApp inkomende prefix)
- Antwoord-threading via `replyToMode` en per-kanaalstandaarden

Details: [Configuratie](/gateway/configuration#messages) en kanaaldocumentatie.
