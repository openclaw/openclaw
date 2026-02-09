---
summary: "Design för kommandokö som serialiserar inkommande körningar för autosvar"
read_when:
  - Ändrar körning eller samtidighet för autosvar
title: "Kommandokö"
---

# Kommandokö (2026-01-16)

Vi serialiserar inkommande körningar för autosvar (alla kanaler) genom en liten kö i processen för att förhindra att flera agentkörningar kolliderar, samtidigt som säker parallellism mellan sessioner tillåts.

## Varför

- Körningar för autosvar kan vara kostsamma (LLM-anrop) och kan kollidera när flera inkommande meddelanden anländer nära i tid.
- Serialisering undviker konkurrens om delade resurser (sessionsfiler, loggar, CLI-stdin) och minskar risken för uppströms hastighetsbegränsningar.

## Så fungerar det

- En körfältsmedveten FIFO-kö tömmer varje körfält med ett konfigurerbart tak för samtidighet (standard 1 för okonfigurerade körfält; main har standard 4, subagent 8).
- `runEmbeddedPiAgent` köar per **sessionsnyckel** (körfält `session:<key>`) för att garantera endast en aktiv körning per session.
- Varje sessionskörning köas sedan in i ett **globalt körfält** (`main` som standard) så att den övergripande parallellismen begränsas av `agents.defaults.maxConcurrent`.
- När utförlig loggning är aktiverad skickar köade körningar en kort notis om de väntade mer än ~2 s innan start.
- Skrivindikatorer utlöses fortfarande omedelbart vid köning (när kanalen stöder det), så användarupplevelsen är oförändrad medan vi väntar på vår tur.

## Kölägen (per kanal)

Inkommande meddelanden kan styra den aktuella körningen, vänta på en uppföljande tur eller göra båda:

- `steer`: injicera omedelbart i den aktuella körningen (avbryter pågående verktygssamtal efter nästa verktygsgräns). Om inte strömmar, faller tillbaka för uppföljning.
- `followup`: köa för nästa agenttur efter att den aktuella körningen avslutas.
- `collect`: koalesce alla köade meddelanden till en **singel** uppföljande tur (standard). Om meddelanden riktar sig till olika kanaler/trådar dräneras de individuellt för att bevara rutten.
- `steer-backlog` (aka `steer+backlog`): styr nu **och** bevara meddelandet för en uppföljande tur.
- `interrupt` (legacy): avbryt den aktiva körningen för den sessionen och kör sedan det senaste meddelandet.
- `queue` (legacy-alias): samma som `steer`.

Steer-backlog innebär att du kan få ett uppföljningssvar efter den styrda körningen, så
strömmande ytor kan se ut som dubbletter. Föredrar `collect`/`steer` om du vill ha
ett svar per inkommande meddelande.
Skicka `/queue collect` som ett fristående kommando (per-session) eller sätt `messages.queue.byChannel.discord: "collect"`.

Standardvärden (när de inte är satta i konfig):

- Alla ytor → `collect`

Konfigurera globalt eller per kanal via `messages.queue`:

```json5
{
  messages: {
    queue: {
      mode: "collect",
      debounceMs: 1000,
      cap: 20,
      drop: "summarize",
      byChannel: { discord: "collect" },
    },
  },
}
```

## Köalternativ

Alternativen gäller för `followup`, `collect` och `steer-backlog` (och för `steer` när den faller tillbaka till uppföljning):

- `debounceMs`: vänta på tystnad innan en uppföljande tur startar (förhindrar ”fortsätt, fortsätt”).
- `cap`: maximalt antal köade meddelanden per session.
- `drop`: överflödspolicy (`old`, `new`, `summarize`).

Sammanfattningsvis håller en kort punktlista över tappade meddelanden och injicerar det som en syntetisk uppföljning snabbt.
Standard: `debounceMs: 1000`, `cap: 20`, `drop: summarize`.

## Per-session-åsidosättningar

- Skicka `/queue <mode>` som ett fristående kommando för att lagra läget för den aktuella sessionen.
- Alternativ kan kombineras: `/queue collect debounce:2s cap:25 drop:summarize`
- `/queue default` eller `/queue reset` rensar sessionsåsidosättningen.

## Omfattning och garantier

- Gäller agentkörningar för autosvar över alla inkommande kanaler som använder gatewayns svars-pipeline (WhatsApp web, Telegram, Slack, Discord, Signal, iMessage, webchat m.fl.).
- Standardkörfält (`main`) är processomfattande för inkommande + main-heartbeats; sätt `agents.defaults.maxConcurrent` för att tillåta flera sessioner parallellt.
- Ytterligare filer kan finnas (t.ex. `cron`, `subagent`) så att bakgrundsjobb kan köras parallellt utan att blockera inkommande svar.
- Körfält per session garanterar att endast en agentkörning rör en given session åt gången.
- Inga externa beroenden eller bakgrundsarbetstrådar; ren TypeScript + promises.

## Felsökning

- Om kommandon verkar fastna, aktivera utförliga loggar och leta efter rader som ”queued for …ms” för att bekräfta att kön töms.
- Om du behöver ködjup, aktivera utförliga loggar och bevaka rader med kötidsinformation.
