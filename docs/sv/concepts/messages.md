---
summary: "Meddelandeflöde, sessioner, köhantering och synlighet för resonemang"
read_when:
  - Förklara hur inkommande meddelanden blir svar
  - Förtydliga sessioner, kölägen eller strömningsbeteende
  - Dokumentera synlighet för resonemang och konsekvenser för användning
title: "Meddelanden"
---

# Meddelanden

Den här sidan knyter samman hur OpenClaw hanterar inkommande meddelanden, sessioner, köhantering,
strömning och synlighet för resonemang.

## Meddelandeflöde (övergripande)

```
Inbound message
  -> routing/bindings -> session key
  -> queue (if a run is active)
  -> agent run (streaming + tools)
  -> outbound replies (channel limits + chunking)
```

Viktiga reglage finns i konfigurationen:

- `messages.*` för prefix, köhantering och gruppbeteende.
- `agents.defaults.*` för blockstreaming och standardvärden för chunking.
- Kanal åsidosätter (`channels.whatsapp.*`, `channels.telegram.*`, etc.) för caps och streaming toggles.

Se [Konfiguration](/gateway/configuration) för fullständigt schema.

## Inkommande deduplicering

Kanaler kan återleverera samma meddelande efter återanslutning. OpenClaw håller en
kortlivad cacheknapp per kanal/konto/peer/session/meddelande-id så att dubbla
leveranser inte utlöser en annan agent som körs.

## Inkommande debouncing

Snabba på varandra följande meddelanden från **samma avsändare** kan buntas in i en enda
agent sväng via `messages.inbound`. Debouncing är scoped per kanal + konversation
och använder det senaste meddelandet för svarstråd/IDs.

Konfig (global standard + per-kanal-överskridningar):

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

Noteringar:

- Debounce gäller **endast textmeddelanden**; media/bilagor töms omedelbart.
- Kontrollkommandon kringgår debouncing så att de förblir fristående.

## Sessioner och enheter

Sessioner ägs av gatewayen, inte av klienter.

- Direktchattar kollapsar till agentens huvudsessionsnyckel.
- Grupper/kanaler får egna sessionsnycklar.
- Sessionslagret och transkript finns på gateway-värden.

Flera enheter/kanaler kan mappa till samma session, men historiken är inte helt
synkroniserad tillbaka till varje klient. Rekommendation: använd en primär enhet för långa
konversationer för att undvika olika sammanhang. Kontroll UI och TUI visar alltid
gateway-backed session transkript, så de är källan till sanningen.

Detaljer: [Sessionshantering](/concepts/session).

## Inkommande kroppar och historikkontext

OpenClaw separerar **promptkroppen** från **kommandokroppen**:

- `Body`: snabb text skickad till agenten. Detta kan inkludera kanalkuvert och
  valfria historikomslag.
- `CommandBody`: rå användartext för direktiv-/kommandotolkning.
- `RawBody`: äldre alias för `CommandBody` (behålls för kompatibilitet).

När en kanal tillhandahåller historik använder den ett gemensamt omslag:

- `[Chat messages since your last reply - for context]`
- `[Current message - respond to this]`

För **icke-direkta chattar** (grupper/kanaler/rum) är **nuvarande meddelandekroppen** prefixet med
avsändaretikett (samma stil som används för historikinlägg). Detta håller realtid och köad/historik
-meddelanden konsekventa i agentprompten.

Historikbuffertar är **endast väntande**: de inkluderar gruppmeddelanden som _inte_
triggade en körning (till exempel meddelanden som kräver omnämnande) och **exkluderar**
meddelanden som redan finns i sessionstranskriptet.

Direktiv strippning gäller endast för **aktuella meddelande** sektionen så historik
förblir intakt. Kanaler som lindar historiken bör sätta `CommandBody` (eller
`RawBody`) till den ursprungliga meddelandetexten och behålla `Body` som den kombinerade prompten.
Historikbuffertar kan konfigureras via `messages.groupChat.historyLimit` (global
standard) och per-channel överskrider som `channels.slack.historyLimit` eller
`channels.telegram.accounts.<id>.historyLimit` (sätt `0` till inaktivera).

## Köhantering och uppföljningar

Om en körning redan är aktiv kan inkommande meddelanden köas, styras in i den
aktuella körningen eller samlas för ett uppföljningsvarv.

- Konfigurera via `messages.queue` (och `messages.queue.byChannel`).
- Lägen: `interrupt`, `steer`, `followup`, `collect`, samt backlog-varianter.

Detaljer: [Köhantering](/concepts/queue).

## Strömning, chunking och batchning

Blockstreaming skickar partiella svar när modellen producerar textblock.
Chunking respekterar kanalens textgränser och undviker delning av inhägnad kod.

Viktiga inställningar:

- `agents.defaults.blockStreamingDefault` (`on|off`, standard av)
- `agents.defaults.blockStreamingBreak` (`text_end|message_end`)
- `agents.defaults.blockStreamingChunk` (`minChars|maxChars|breakPreference`)
- `agents.defaults.blockStreamingCoalesce` (inaktivitetbaserad batchning)
- `agents.defaults.humanDelay` (människolik paus mellan blocksvar)
- Kanalöverskridningar: `*.blockStreaming` och `*.blockStreamingCoalesce` (icke-Telegram-kanaler kräver explicit `*.blockStreaming: true`)

Detaljer: [Strömning + chunking](/concepts/streaming).

## Synlighet för resonemang och token

OpenClaw kan visa eller dölja modellens resonemang:

- `/reasoning on|off|stream` styr synligheten.
- Resonemangsinnehåll räknas fortfarande mot tokenanvändning när det produceras av modellen.
- Telegram stöder strömning av resonemang in i utkastbubblan.

Detaljer: [Tänkande + resonemangsdirektiv](/tools/thinking) och [Tokenanvändning](/reference/token-use).

## Prefix, trådning och svar

Formatering av utgående meddelanden är centraliserad i `messages`:

- `messages.responsePrefix`, `kanaler.<channel>.responsePrefix`, och `kanaler.<channel>.accounts.<id>.responsePrefix` (utgående prefix kaskade), plus `channels.whatsapp.messagePrefix` (WhatsApp inkommande prefix)
- Svarstrådning via `replyToMode` och per-kanalstandarder

Detaljer: [Konfiguration](/gateway/configuration#messages) och kanaldokumentation.
