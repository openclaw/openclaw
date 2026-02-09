---
summary: "Agent-loopens livscyklus, streams og vent-semantik"
read_when:
  - Du har brug for en præcis gennemgang af agent-loopet eller livscyklusbegivenheder
title: "Agent Loop"
---

# Agent Loop (OpenClaw)

En agentisk løkke er den fulde “rigtige” kørsel af en agent: indtagelse → kontekst samling → model inferens →
værktøj udførelse → streaming svar → vedholdenhed. Det er den autoritative sti, der forvandler en besked
til handlinger og et endeligt svar, samtidig med at sessionstilstanden er konsekvent.

I OpenClaw, en løkke er en enkelt, serialiseret løb per session, der udsender livscyklus og stream begivenheder
som modellen mener, kalder værktøjer og streams output. Denne doc forklarer, hvordan autentiske løkke er
kablet end-to-end.

## Indgangspunkter

- Gateway RPC: `agent` og `agent.wait`.
- CLI: `agent`-kommando.

## Sådan virker det (overblik)

1. `agent` RPC validerer parametre, resolver session (sessionKey/sessionId), persisterer sessionmetadata og returnerer `{ runId, acceptedAt }` med det samme.
2. `agentCommand` kører agenten:
   - resolver model + standarder for thinking/verbose
   - indlæser Skills-snapshot
   - kalder `runEmbeddedPiAgent` (pi-agent-core runtime)
   - udsender **lifecycle end/error**, hvis det indlejrede loop ikke selv udsender en
3. `runEmbeddedPiAgent`:
   - serialiserer kørsler via pr.-session- og globale køer
   - resolver model + auth-profil og bygger pi-sessionen
   - abonnerer på pi-events og streamer assistant-/tool-deltaer
   - håndhæver timeout → afbryder kørsel ved overskridelse
   - returnerer payloads + brugsmetadata
4. `subscribeEmbeddedPiSession` forbinder pi-agent-core-events til OpenClaw `agent`-stream:
   - tool-events => `stream: "tool"`
   - assistant-deltaer => `stream: "assistant"`
   - livscyklus-events => `stream: "lifecycle"` (`phase: "start" | "end" | "error"`)
5. `agent.wait` bruger `waitForAgentJob`:
   - venter på **lifecycle end/error** for `runId`
   - returnerer `{ status: okřišijjjjjjjjjjjjjjjju timeout, startedAt, endedAt, fejl? }`

## Køer + samtidighed

- Kørsler serialiseres pr. sessionsnøgle (sessionsbane) og eventuelt gennem en global bane.
- Dette forhindrer værktøjs-/sessionsræs og holder sessionshistorik konsistent.
- Messaging-kanaler kan vælge køtilstande (collect/steer/followup), der fodrer denne vognbane-system.
  Se [Kommandokø](/concepts/queue).

## Session- + workspace-forberedelse

- Workspace resolves og oprettes; sandboxede kørsler kan omdirigere til en sandbox workspace-rod.
- Skills indlæses (eller genbruges fra et snapshot) og injiceres i env og prompt.
- Bootstrap-/kontekstfiler resolves og injiceres i systemprompt-rapporten.
- En sessions-skrivelås erhverves; `SessionManager` åbnes og klargøres før streaming.

## Prompt-samling + systemprompt

- Systemprompten bygges fra OpenClaws basisprompt, Skills-prompt, bootstrap-kontekst og pr.-kørsel-override.
- Modelspecificerede grænser og tokens reserveret til kompaktering håndhæves.
- Se [System prompt](/concepts/system-prompt) for, hvad modellen ser.

## Hook-punkter (hvor du kan gribe ind)

OpenClaw har to hook-systemer:

- **Interne hooks** (Gateway-hooks): hændelsesdrevne scripts for kommandoer og livscyklusbegivenheder.
- **Plugin-hooks**: udvidelsespunkter inde i agent-/værktøjslivscyklussen og gateway-pipelinen.

### Interne hooks (Gateway-hooks)

- **`agent:bootstrap`**: kører, mens du bygger bootstrap filer, før systemprompten er afsluttet.
  Brug denne til at tilføje / fjerne bootstrap kontekstfiler.
- **Command hooks**: `/new`, `/reset`, `/stop` og andre kommandohændelser (se Hooks-dokumentet).

Se [Hooks](/automation/hooks) for opsætning og eksempler.

### Plugin-hooks (agent + gateway-livscyklus)

Disse kører inde i agent-loopet eller gateway-pipelinen:

- **`before_agent_start`**: injicer kontekst eller overstyr systemprompt før kørslen starter.
- **`agent_end`**: inspicér den endelige beskedliste og kørselsmetadata efter afslutning.
- **`before_compaction` / `after_compaction`**: observer eller annotér kompakteringscyklusser.
- **`before_tool_call` / `after_tool_call`**: aflyt værktøjsparametre/-resultater.
- **`tool_result_persist`**: transformér værktøjsresultater synkront, før de skrives til sessionstranskriptet.
- **`message_received` / `message_sending` / `message_sent`**: indgående + udgående besked-hooks.
- **`session_start` / `session_end`**: sessionens livscyklusgrænser.
- **`gateway_start` / `gateway_stop`**: gateway-livscyklusbegivenheder.

Se [Plugins](/tools/plugin#plugin-hooks) for hook-API’et og registreringsdetaljer.

## Streaming + delvise svar

- Assistant-deltaer streames fra pi-agent-core og udsendes som `assistant`-events.
- Blokstreaming kan udsende delvise svar enten på `text_end` eller `message_end`.
- Reasoning-streaming kan udsendes som en separat stream eller som bloksvar.
- Se [Streaming](/concepts/streaming) for chunking og blok-svar-adfærd.

## Værktøjseksekvering + messaging-værktøjer

- Værktøjs start-/opdaterings-/slut-events udsendes på `tool`-streamen.
- Værktøjsresultater renses for størrelse og billedpayloads før logning/udsendelse.
- Afsendelser via messaging-værktøjer spores for at undertrykke dublerede assistant-bekræftelser.

## Svarformning + undertrykkelse

- Endelige payloads samles fra:
  - assistant-tekst (og valgfri reasoning)
  - inline værktøjsresuméer (når verbose + tilladt)
  - assistant-fejltekst når modellen fejler
- `NO_REPLY` behandles som et tavst token og filtreres fra udgående payloads.
- Dubletter fra messaging-værktøjer fjernes fra den endelige payload-liste.
- Hvis ingen renderbare payloads er tilbage og et værktøj fejlede, udsendes et fallback-værktøjsfejlsvar
  (medmindre et messaging-værktøj allerede sendte et synligt svar til brugeren).

## Kompaktering + genforsøg

- Automatisk kompaktering udsender `compaction`-stream-events og kan udløse et genforsøg.
- Ved genforsøg nulstilles in-memory-buffere og værktøjsresuméer for at undgå dubleret output.
- Se [Compaction](/concepts/compaction) for kompakteringspipelinen.

## Event-streams (i dag)

- `lifecycle`: udsendt af `subscribeEmbeddedPiSession` (og som fallback af `agentCommand`)
- `assistant`: streamede deltaer fra pi-agent-core
- `tool`: streamede værktøjsevents fra pi-agent-core

## Håndtering af chat-kanaler

- Assistant-deltaer buffers til chat `delta`-beskeder.
- En chat `final` udsendes ved **lifecycle end/error**.

## Timeouts

- `agent.wait` standard: 30s (kun ventet). `timeoutMs` param overrides.
- Agent-runtime: `agents.defaults.timeoutSeconds` standard 600s; håndhæves i `runEmbeddedPiAgent`-aborttimeren.

## Hvor ting kan slutte tidligt

- Agent-timeout (abort)
- AbortSignal (annullér)
- Gateway-frakobling eller RPC-timeout
- `agent.wait`-timeout (kun vent, stopper ikke agenten)
