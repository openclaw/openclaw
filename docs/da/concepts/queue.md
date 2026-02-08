---
summary: "Design af kommandokø, der serialiserer indgående auto-svar-kørsler"
read_when:
  - Ændring af udførelse eller samtidighed for auto-svar
title: "Kommandokø"
x-i18n:
  source_path: concepts/queue.md
  source_hash: 2104c24d200fb4f9
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:17Z
---

# Kommandokø (2026-01-16)

Vi serialiserer indgående auto-svar-kørsler (alle kanaler) gennem en lille in-process-kø for at forhindre, at flere agentkørsler kolliderer, samtidig med at sikker parallelisme på tværs af sessioner stadig er mulig.

## Hvorfor

- Auto-svar-kørsler kan være dyre (LLM-kald) og kan kollidere, når flere indgående beskeder ankommer tæt på hinanden.
- Serialisering undgår konkurrence om delte ressourcer (sessionsfiler, logs, CLI stdin) og reducerer risikoen for upstream rate limits.

## Sådan virker det

- En lane-bevidst FIFO-kø dræner hver lane med et konfigurerbart loft for samtidighed (standard 1 for u-konfigurerede lanes; main er som standard 4, subagent 8).
- `runEmbeddedPiAgent` køer efter **sessionsnøgle** (lane `session:<key>`) for at garantere kun én aktiv kørsel pr. session.
- Hver sessionskørsel sættes derefter i kø i en **global lane** (`main` som standard), så den samlede parallelisme begrænses af `agents.defaults.maxConcurrent`.
- Når udførlig logning er aktiveret, udsender køede kørsler en kort meddelelse, hvis de ventede mere end ~2 s før start.
- Skriveindikatorer udløses stadig med det samme ved enqueue (når kanalen understøtter det), så brugeroplevelsen er uændret, mens vi venter på tur.

## Køtilstande (pr. kanal)

Indgående beskeder kan styre den aktuelle kørsel, vente på en opfølgende tur eller gøre begge dele:

- `steer`: injicér straks i den aktuelle kørsel (annullerer afventende værktøjskald efter næste værktøjsgrænse). Hvis der ikke streames, falder den tilbage til opfølgning.
- `followup`: sæt i kø til næste agenttur, efter den aktuelle kørsel slutter.
- `collect`: sammenlæg alle køede beskeder til **én** opfølgende tur (standard). Hvis beskeder målretter forskellige kanaler/tråde, drænes de individuelt for at bevare routing.
- `steer-backlog` (aka `steer+backlog`): styr nu **og** bevar beskeden til en opfølgende tur.
- `interrupt` (legacy): afbryd den aktive kørsel for den session, og kør derefter den nyeste besked.
- `queue` (legacy alias): samme som `steer`.

Steer-backlog betyder, at du kan få et opfølgende svar efter den styrede kørsel, så
streaming-overflader kan se ud som dubletter. Foretræk `collect`/`steer`, hvis du vil have
ét svar pr. indgående besked.
Send `/queue collect` som en selvstændig kommando (pr. session), eller sæt `messages.queue.byChannel.discord: "collect"`.

Standarder (når de ikke er sat i konfigurationen):

- Alle overflader → `collect`

Konfigurér globalt eller pr. kanal via `messages.queue`:

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

## Køindstillinger

Indstillinger gælder for `followup`, `collect` og `steer-backlog` (og for `steer`, når den falder tilbage til opfølgning):

- `debounceMs`: vent på stilhed før start af en opfølgende tur (forhindrer “fortsæt, fortsæt”).
- `cap`: maks. antal køede beskeder pr. session.
- `drop`: overflow-politik (`old`, `new`, `summarize`).

Summarize bevarer en kort punktliste over droppede beskeder og injicerer den som en syntetisk opfølgende prompt.
Standarder: `debounceMs: 1000`, `cap: 20`, `drop: summarize`.

## Tilsidesættelser pr. session

- Send `/queue <mode>` som en selvstændig kommando for at gemme tilstanden for den aktuelle session.
- Indstillinger kan kombineres: `/queue collect debounce:2s cap:25 drop:summarize`
- `/queue default` eller `/queue reset` rydder sessions-tilsidesættelsen.

## Omfang og garantier

- Gælder for auto-svar-agentkørsler på tværs af alle indgående kanaler, der bruger gateway-svar-pipelinen (WhatsApp web, Telegram, Slack, Discord, Signal, iMessage, webchat m.fl.).
- Standard-lane (`main`) er procesdækkende for indgående + main heartbeats; sæt `agents.defaults.maxConcurrent` for at tillade flere sessioner parallelt.
- Yderligere lanes kan findes (fx `cron`, `subagent`), så baggrundsjob kan køre parallelt uden at blokere indgående svar.
- Pr.-session-lanes garanterer, at kun én agentkørsel berører en given session ad gangen.
- Ingen eksterne afhængigheder eller baggrundsarbejdertråde; ren TypeScript + promises.

## Fejlfinding

- Hvis kommandoer ser ud til at sidde fast, aktivér udførlige logs og kig efter linjer med “queued for …ms” for at bekræfte, at køen drænes.
- Hvis du har brug for kødybde, aktivér udførlige logs og hold øje med linjer om køtiming.
