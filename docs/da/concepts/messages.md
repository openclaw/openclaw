---
summary: "Meddelelsesflow, sessioner, køhåndtering og synlighed af ræsonnement"
read_when:
  - Forklaring af, hvordan indgående meddelelser bliver til svar
  - Afklaring af sessioner, køhåndteringsmetoder eller streamingadfærd
  - Dokumentation af synlighed af ræsonnement og konsekvenser for brug
title: "Meddelelser"
x-i18n:
  source_path: concepts/messages.md
  source_hash: 773301d5c0c1e3b8
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:21Z
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
- Kanaloverstyringer (`channels.whatsapp.*`, `channels.telegram.*`, osv.) for grænser og streaming‑til/fra.

Se [Konfiguration](/gateway/configuration) for fuldt skema.

## Indgående deduplikering

Kanaler kan genlevere den samme meddelelse efter genforbindelser. OpenClaw holder en
kortlivet cache med nøgle af kanal/konto/peer/session/meddelelses-id, så duplikerede
leveringer ikke udløser endnu et agent‑run.

## Indgående debouncing

Hurtige, efterfølgende meddelelser fra **samme afsender** kan samles i én agent‑tur via
`messages.inbound`. Debouncing er afgrænset pr. kanal + samtale og bruger den seneste
meddelelse til svartrådning/ID’er.

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

Flere enheder/kanaler kan mappe til den samme session, men historik synkroniseres ikke fuldt
til alle klienter. Anbefaling: brug én primær enhed til lange samtaler for at undgå
divergerende kontekst. Control UI og TUI viser altid den gateway‑understøttede
sessionstransskription og er derfor sandhedskilden.

Detaljer: [Sessionsstyring](/concepts/session).

## Indgående bodies og historikkontekst

OpenClaw adskiller **prompt‑body** fra **kommando‑body**:

- `Body`: prompttekst sendt til agenten. Dette kan inkludere kanalindpakninger og
  valgfrie historikomslag.
- `CommandBody`: rå brugertekst til direktiv-/kommandofortolkning.
- `RawBody`: legacy‑alias for `CommandBody` (bevares for kompatibilitet).

Når en kanal leverer historik, bruger den et delt omslag:

- `[Chat messages since your last reply - for context]`
- `[Current message - respond to this]`

For **ikke‑direkte chats** (grupper/kanaler/rum) præfikses **den aktuelle meddelelses‑body**
med afsenderetiketten (samme stil som bruges for historikposter). Det holder realtids‑ og
kø-/historikmeddelelser konsistente i agent‑prompten.

Historikbuffere er **kun afventende**: de inkluderer gruppemeddelelser, der _ikke_
udløste et run (fx mention‑afgrænsede meddelelser) og **udelukker** meddelelser, der
allerede er i sessionstransskriptionen.

Fjernelse af direktiver gælder kun for **den aktuelle meddelelses**‑sektion, så historikken
forbliver intakt. Kanaler, der indpakker historik, bør sætte `CommandBody` (eller
`RawBody`) til den oprindelige meddelelsestekst og beholde `Body` som den
samlede prompt. Historikbuffere kan konfigureres via `messages.groupChat.historyLimit` (global
standard) og pr. kanal‑overstyringer som `channels.slack.historyLimit` eller
`channels.telegram.accounts.<id>.historyLimit` (sæt `0` for at deaktivere).

## Køhåndtering og opfølgninger

Hvis et run allerede er aktivt, kan indgående meddelelser sættes i kø, styres ind i
det aktuelle run eller samles til en opfølgende tur.

- Konfigurer via `messages.queue` (og `messages.queue.byChannel`).
- Tilstande: `interrupt`, `steer`, `followup`, `collect`, plus backlog‑varianter.

Detaljer: [Køhåndtering](/concepts/queue).

## Streaming, chunking og batching

Blokstreaming sender delvise svar, efterhånden som modellen producerer tekstblokke.
Chunking respekterer kanalernes tekstgrænser og undgår at splitte indhegnede kodeblokke.

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

- `messages.responsePrefix`, `channels.<channel>.responsePrefix` og `channels.<channel>.accounts.<id>.responsePrefix` (kaskade for udgående præfiks), plus `channels.whatsapp.messagePrefix` (WhatsApp indgående præfiks)
- Svartrådning via `replyToMode` og pr. kanal‑standarder

Detaljer: [Konfiguration](/gateway/configuration#messages) og kanal‑dokumentation.
