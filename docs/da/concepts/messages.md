---
summary: "Meddelelsesflow, sessioner, køhåndtering og synlighed af ræsonnement"
read_when:
  - Forklaring af, hvordan indgående meddelelser bliver til svar
  - Afklaring af sessioner, køhåndteringsmetoder eller streamingadfærd
  - Dokumentation af synlighed af ræsonnement og konsekvenser for brug
title: "Meddelelser"
---

# Meddelelser

Denne side samler, hvordan OpenClaw håndterer indgående meddelelser, sessioner, køhåndtering,
streaming og synlighed af ræsonnement.

## Meddelelsesflow (overordnet)

```
Inbound message
  -> routing/bindings -> session key
  -> queue (if a run is active)
  -> agent run (streaming + tools)
  -> outbound replies (channel limits + chunking)
```

Vigtige indstillinger findes i konfigurationen:

- `messages.*` for præfikser, køhåndtering og gruppeadfærd.
- `agents.defaults.*` for standarder for blokstreaming og chunking.
- Kanal tilsidesættelser (`channels.whatsapp.*`, `channels.telegram.*`, etc.) for hætter og streaming skifter.

Se [Konfiguration](/gateway/configuration) for fuldt skema.

## Indgående deduplikering

Kanaler kan genlevere den samme besked efter genoprettelse. OpenClaw beholder en
kortlivede cache-nøgle ved kanal/account/peer/session/message id så duplikerede
-leverancer ikke udløser en anden agent kørsel.

## Indgående debouncing

Hurtige meddelelser fra den **samme afsender** kan sendes til en enkelt
agent slå via `messages.inbound`. Debouncing er scoped per kanal + conversation
og bruger den seneste meddelelse til svar tråde / IDs.

Konfiguration (global standard + pr. kanal‑overstyringer):

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

Noter:

- Debounce gælder for **kun tekst**‑meddelelser; medier/vedhæftninger flushes med det samme.
- Kontrolkommandoer omgår debouncing, så de forbliver selvstændige.

## Sessioner og enheder

Sessioner ejes af gatewayen, ikke af klienter.

- Direkte chats samles i agentens primære sessionsnøgle.
- Grupper/kanaler får deres egne sessionsnøgler.
- Sessionslageret og transskripter ligger på gateway‑værten.

Flere enheder/kanaler kan kortlægge til den samme session, men historikken er ikke fuldt ud
synkroniseret tilbage til hver klient. Anbefaling: Brug en primær enhed til lange
samtaler for at undgå divergerende kontekst. Kontrol-UI og TUI viser altid
gateway-bakket session udskrift, så de er kilden til sandhed.

Detaljer: [Sessionsstyring](/concepts/session).

## Indgående bodies og historikkontekst

OpenClaw adskiller **prompt‑body** fra **kommando‑body**:

- `Body`: prompt tekst sendt til agent. Dette kan omfatte kanal konvolutter og
  valgfri historie indpakninger.
- `CommandBody`: rå brugertekst til direktiv-/kommandofortolkning.
- `RawBody`: legacy‑alias for `CommandBody` (bevares for kompatibilitet).

Når en kanal leverer historik, bruger den et delt omslag:

- `[Chat messages since your last reply - for context]`
- `[Current message - respond to this]`

For **ikke-direkte chats** (grupper/kanaler/rum), er **nuværende meddelelseskort** præfikseret med
afsenderetiketten (samme stil som for historikindlæg). Dette holder real-time og kø/historik
beskeder konsistente i agent prompten.

Historikbuffere er **kun afventende**: de inkluderer gruppemeddelelser, der _ikke_
udløste et run (fx mention‑afgrænsede meddelelser) og **udelukker** meddelelser, der
allerede er i sessionstransskriptionen.

Direktiv stripning gælder kun for \*\* nuværende besked\*\* sektionen, så historie
forbliver intakt. Kanaler som wrap historie skal sætte `CommandBody` (eller
`RawBody`) til den oprindelige besked tekst og beholde `Body` som den kombinerede prompt.
Historie buffere kan konfigureres via `messages.groupChat.historyLimit` (global
standard) og per-kanal tilsidesætter som `channels.slack.historyLimit` eller
`channels.telegram.accounts.<id>.historyLimit` (sæt `0` til deaktiveret).

## Køhåndtering og opfølgninger

Hvis et run allerede er aktivt, kan indgående meddelelser sættes i kø, styres ind i
det aktuelle run eller samles til en opfølgende tur.

- Konfigurer via `messages.queue` (og `messages.queue.byChannel`).
- Tilstande: `interrupt`, `steer`, `followup`, `collect`, plus backlog‑varianter.

Detaljer: [Køhåndtering](/concepts/queue).

## Streaming, chunking og batching

Blokstreaming sender delvise svar, da modellen producerer tekstblokke.
Chunking respekterer kanaltekst grænser og undgår at opdele indhegnet kode.

Nøgleindstillinger:

- `agents.defaults.blockStreamingDefault` (`on|off`, standard fra)
- `agents.defaults.blockStreamingBreak` (`text_end|message_end`)
- `agents.defaults.blockStreamingChunk` (`minChars|maxChars|breakPreference`)
- `agents.defaults.blockStreamingCoalesce` (idle‑baseret batching)
- `agents.defaults.humanDelay` (menneskelignende pause mellem blok‑svar)
- Kanaloverstyringer: `*.blockStreaming` og `*.blockStreamingCoalesce` (ikke‑Telegram‑kanaler kræver eksplicit `*.blockStreaming: true`)

Detaljer: [Streaming + chunking](/concepts/streaming).

## Synlighed af ræsonnement og tokens

OpenClaw kan eksponere eller skjule modellens ræsonnement:

- `/reasoning on|off|stream` styrer synligheden.
- Ræsonnementindhold tæller stadig med i tokenforbruget, når det produceres af modellen.
- Telegram understøtter ræsonnementstreaming ind i kladde‑boblen.

Detaljer: [Thinking + reasoning‑direktiver](/tools/thinking) og [Tokenforbrug](/reference/token-use).

## Præfikser, trådning og svar

Udgående meddelelsesformatering er centraliseret i `messages`:

- `messages.responsePrefix`, `kanaler.<channel>.responsePrefix`, og `kanaler.<channel>.accounts.<id>.responsePrefix` (udgående præfiks kade), plus `channels.whatsapp.messagePrefix` (WhatsApp indgående præfiks)
- Svartrådning via `replyToMode` og pr. kanal‑standarder

Detaljer: [Konfiguration](/gateway/configuration#messages) og kanal‑dokumentation.
