---
summary: "Meddelandeflöde, sessioner, köhantering och synlighet för resonemang"
read_when:
  - Förklara hur inkommande meddelanden blir svar
  - Förtydliga sessioner, kölägen eller strömningsbeteende
  - Dokumentera synlighet för resonemang och konsekvenser för användning
title: "Meddelanden"
x-i18n:
  source_path: concepts/messages.md
  source_hash: 773301d5c0c1e3b8
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:17:03Z
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
- Kanalöverskridningar (`channels.whatsapp.*`, `channels.telegram.*`, osv.) för begränsningar och strömningsväxlar.

Se [Konfiguration](/gateway/configuration) för fullständigt schema.

## Inkommande deduplicering

Kanaler kan leverera samma meddelande igen efter återanslutningar. OpenClaw behåller en
kortlivad cache nycklad på kanal/konto/peer/session/meddelande-id så att dubbla leveranser
inte triggar ytterligare en agentkörning.

## Inkommande debouncing

Snabba efterföljande meddelanden från **samma avsändare** kan buntas till ett enda
agentvarv via `messages.inbound`. Debouncing är avgränsad per kanal + konversation
och använder det senaste meddelandet för svarstrådning/ID:n.

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

Flera enheter/kanaler kan mappas till samma session, men historiken synkas inte fullt ut
till varje klient. Rekommendation: använd en primär enhet för långa konversationer
för att undvika divergerande kontext. Kontroll-UI och TUI visar alltid det
gateway-backade sessionstranskriptet och är därför sanningskällan.

Detaljer: [Sessionshantering](/concepts/session).

## Inkommande kroppar och historikkontext

OpenClaw separerar **promptkroppen** från **kommandokroppen**:

- `Body`: prompttext som skickas till agenten. Den kan inkludera kanalomslag och
  valfria historikomslag.
- `CommandBody`: rå användartext för direktiv-/kommandotolkning.
- `RawBody`: äldre alias för `CommandBody` (behålls för kompatibilitet).

När en kanal tillhandahåller historik använder den ett gemensamt omslag:

- `[Chat messages since your last reply - for context]`
- `[Current message - respond to this]`

För **icke-direktchattar** (grupper/kanaler/rum) prefixeras **den aktuella meddelandekroppen**
med avsändaretiketten (samma stil som används för historikposter). Detta håller realtids-
och köade/historikmeddelanden konsekventa i agentens prompt.

Historikbuffertar är **endast väntande**: de inkluderar gruppmeddelanden som _inte_
triggade en körning (till exempel meddelanden som kräver omnämnande) och **exkluderar**
meddelanden som redan finns i sessionstranskriptet.

Direktivstrippning gäller endast avsnittet **aktuellt meddelande** så att historiken
förblir intakt. Kanaler som omsluter historik bör sätta `CommandBody` (eller
`RawBody`) till originalmeddelandets text och behålla `Body` som den
kombinerade prompten. Historikbuffertar konfigureras via `messages.groupChat.historyLimit` (global
standard) och per-kanal-överskridningar som `channels.slack.historyLimit` eller
`channels.telegram.accounts.<id>.historyLimit` (sätt `0` för att inaktivera).

## Köhantering och uppföljningar

Om en körning redan är aktiv kan inkommande meddelanden köas, styras in i den
aktuella körningen eller samlas för ett uppföljningsvarv.

- Konfigurera via `messages.queue` (och `messages.queue.byChannel`).
- Lägen: `interrupt`, `steer`, `followup`, `collect`, samt backlog-varianter.

Detaljer: [Köhantering](/concepts/queue).

## Strömning, chunking och batchning

Blockstreaming skickar partiella svar i takt med att modellen producerar textblock.
Chunking respekterar kanalernas textgränser och undviker att dela inhägnad kod.

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

- `messages.responsePrefix`, `channels.<channel>.responsePrefix` och `channels.<channel>.accounts.<id>.responsePrefix` (kaskad för utgående prefix), samt `channels.whatsapp.messagePrefix` (WhatsApp inkommande prefix)
- Svarstrådning via `replyToMode` och per-kanalstandarder

Detaljer: [Konfiguration](/gateway/configuration#messages) och kanaldokumentation.
