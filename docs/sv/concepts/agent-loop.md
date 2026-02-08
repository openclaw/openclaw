---
summary: "Agentloopens livscykel, strömmar och väntesemantik"
read_when:
  - Du behöver en exakt genomgång av agentloopen eller livscykelhändelser
title: "Agentloop"
x-i18n:
  source_path: concepts/agent-loop.md
  source_hash: e2c14fb74bd42caa
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:17:03Z
---

# Agentloop (OpenClaw)

En agentisk loop är den fullständiga ”verkliga” körningen av en agent: intag → kontextsammanställning → modellinferens →
verktygskörning → strömmande svar → persistens. Det är den auktoritativa vägen som omvandlar ett meddelande
till åtgärder och ett slutligt svar, samtidigt som sessionstillståndet hålls konsekvent.

I OpenClaw är en loop en enda, serialiserad körning per session som emitterar livscykel- och strömhändelser
när modellen tänker, anropar verktyg och strömmar utdata. Detta dokument förklarar hur den autentiska loopen
är kopplad från ände till ände.

## Ingångspunkter

- Gateway-RPC: `agent` och `agent.wait`.
- CLI: kommandot `agent`.

## Hur det fungerar (övergripande)

1. `agent`-RPC validerar parametrar, löser session (sessionKey/sessionId), persisterar sessionsmetadata och returnerar `{ runId, acceptedAt }` omedelbart.
2. `agentCommand` kör agenten:
   - löser modell + standardvärden för thinking/verbose
   - läser in Skills-ögonblicksbild
   - anropar `runEmbeddedPiAgent` (pi-agent-core runtime)
   - emitterar **lifecycle end/error** om den inbäddade loopen inte emitterar en sådan
3. `runEmbeddedPiAgent`:
   - serialiserar körningar via per-session- och globala köer
   - löser modell + autentiseringsprofil och bygger pi-sessionen
   - prenumererar på pi-händelser och strömmar assistant-/verktygsdeltor
   - upprätthåller timeout → avbryter körningen om den överskrids
   - returnerar payloads + användningsmetadata
4. `subscribeEmbeddedPiSession` bryggar pi-agent-core-händelser till OpenClaws `agent`-ström:
   - verktygshändelser ⇒ `stream: "tool"`
   - assistant-deltor ⇒ `stream: "assistant"`
   - livscykelhändelser ⇒ `stream: "lifecycle"` (`phase: "start" | "end" | "error"`)
5. `agent.wait` använder `waitForAgentJob`:
   - väntar på **lifecycle end/error** för `runId`
   - returnerar `{ status: ok|error|timeout, startedAt, endedAt, error? }`

## Köhantering + samtidighet

- Körningar serialiseras per sessionsnyckel (sessionsfil) och valfritt via en global fil.
- Detta förhindrar verktygs-/sessionsrace och håller sessionshistoriken konsekvent.
- Meddelandekanaler kan välja kölägen (collect/steer/followup) som matar detta filsystem.
  Se [Command Queue](/concepts/queue).

## Förberedelse av session + arbetsyta

- Arbetsytan löses och skapas; sandboxade körningar kan omdirigera till en sandbox-arbetsyterot.
- Skills läses in (eller återanvänds från en ögonblicksbild) och injiceras i miljö och prompt.
- Bootstrap-/kontextfiler löses och injiceras i systemprompt-rapporten.
- Ett skrivlås för sessionen tas; `SessionManager` öppnas och förbereds före strömning.

## Prompt-sammanställning + systemprompt

- Systemprompten byggs från OpenClaws basprompt, Skills-prompt, bootstrap-kontext och per-körningsöverskrivningar.
- Modellspecifika gränser och reservtoken för komprimering upprätthålls.
- Se [System prompt](/concepts/system-prompt) för vad modellen ser.

## Hook-punkter (där du kan intercepta)

OpenClaw har två hook-system:

- **Interna hooks** (Gateway-hooks): händelsedrivna skript för kommandon och livscykelhändelser.
- **Plugin-hooks**: utökningspunkter i agent-/verktygslivscykeln och gateway-pipelinen.

### Interna hooks (Gateway-hooks)

- **`agent:bootstrap`**: körs medan bootstrap-filer byggs innan systemprompten slutförs.
  Använd detta för att lägga till/ta bort bootstrap-kontextfiler.
- **Command hooks**: `/new`, `/reset`, `/stop` och andra kommandohändelser (se Hooks-dokumentet).

Se [Hooks](/automation/hooks) för konfigurering och exempel.

### Plugin-hooks (agent- + gateway-livscykel)

Dessa körs inuti agentloopen eller gateway-pipelinen:

- **`before_agent_start`**: injicera kontext eller åsidosätt systemprompten innan körningen startar.
- **`agent_end`**: inspektera den slutliga meddelandelistan och körningsmetadata efter slutförande.
- **`before_compaction` / `after_compaction`**: observera eller annotera komprimeringscykler.
- **`before_tool_call` / `after_tool_call`**: intercepta verktygsparametrar/-resultat.
- **`tool_result_persist`**: synkront transformera verktygsresultat innan de skrivs till sessionstranskriptet.
- **`message_received` / `message_sending` / `message_sent`**: inkommande + utgående meddelande-hooks.
- **`session_start` / `session_end`**: gränser för sessionslivscykeln.
- **`gateway_start` / `gateway_stop`**: gateway-livscykelhändelser.

Se [Plugins](/tools/plugin#plugin-hooks) för hook-API:t och registreringsdetaljer.

## Strömning + partiella svar

- Assistant-deltor strömmas från pi-agent-core och emitteras som `assistant`-händelser.
- Blockstreaming kan emittera partiella svar antingen på `text_end` eller `message_end`.
- Resonemangsströmning kan emitteras som en separat ström eller som blocksvar.
- Se [Streaming](/concepts/streaming) för chunking- och blocksvarsbeteende.

## Verktygskörning + meddelandeverktyg

- Händelser för verktygsstart/uppdatering/slut emitteras på `tool`-strömmen.
- Verktygsresultat saneras för storlek och bildpayloads före loggning/emission.
- Sändningar via meddelandeverktyg spåras för att undertrycka dubbla assistant-bekräftelser.

## Svarsformning + undertryckning

- Slutliga payloads sammanställs från:
  - assistant-text (och valfritt resonemang)
  - inbäddade verktygssammanfattningar (när verbose + tillåtet)
  - assistant-feltext när modellen felar
- `NO_REPLY` behandlas som en tyst token och filtreras bort från utgående payloads.
- Dubbletter från meddelandeverktyg tas bort från den slutliga payload-listan.
- Om inga renderbara payloads återstår och ett verktyg felade, emitteras ett fallback-svar för verktygsfel
  (om inte ett meddelandeverktyg redan skickade ett användarsynligt svar).

## Komprimering + omförsök

- Autokomprimering emitterar `compaction`-strömhändelser och kan trigga ett omförsök.
- Vid omförsök återställs minnesbuffertar och verktygssammanfattningar för att undvika dubblerad utdata.
- Se [Compaction](/concepts/compaction) för komprimeringspipelinen.

## Händelseströmmar (idag)

- `lifecycle`: emitteras av `subscribeEmbeddedPiSession` (och som fallback av `agentCommand`)
- `assistant`: strömmade deltor från pi-agent-core
- `tool`: strömmade verktygshändelser från pi-agent-core

## Hantering av chattkanaler

- Assistant-deltor buffras till chattens `delta`-meddelanden.
- Ett chatt-`final` emitteras vid **lifecycle end/error**.

## Timeouts

- `agent.wait` standard: 30 s (endast väntan). Parametern `timeoutMs` åsidosätter.
- Agentkörning: `agents.defaults.timeoutSeconds` standard 600 s; upprätthålls i `runEmbeddedPiAgent`-avbrottstimern.

## Var saker kan avslutas i förtid

- Agent-timeout (avbrott)
- AbortSignal (avbryt)
- Gateway-frånkoppling eller RPC-timeout
- `agent.wait`-timeout (endast väntan, stoppar inte agenten)
