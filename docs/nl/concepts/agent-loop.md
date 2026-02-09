---
summary: "Levenscyclus van de agentlus, streams en wachtsemantiek"
read_when:
  - Je hebt een exacte walkthrough nodig van de agentlus of levenscyclusgebeurtenissen
title: "Agentlus"
---

# Agentlus (OpenClaw)

Een agentische lus is de volledige “echte” uitvoering van een agent: intake → contextopbouw → modelinferentie →
toolexecutie → streaming van antwoorden → persistentie. Het is het gezaghebbende pad dat een bericht
omzet in acties en een definitief antwoord, terwijl de sessiestatus consistent blijft.

In OpenClaw is een lus één enkele, geserialiseerde uitvoering per sessie die levenscyclus- en streamgebeurtenissen
uitzendt terwijl het model denkt, tools aanroept en uitvoer streamt. Dit document legt uit hoe die authentieke lus
end-to-end is opgebouwd.

## Ingangspunten

- Gateway RPC: `agent` en `agent.wait`.
- CLI: opdracht `agent`.

## Hoe het werkt (op hoofdlijnen)

1. `agent` RPC valideert parameters, resolveert de sessie (sessionKey/sessionId), schrijft sessiemetadata weg en retourneert `{ runId, acceptedAt }` onmiddellijk.
2. `agentCommand` voert de agent uit:
   - resolveert model + standaardwaarden voor thinking/verbose
   - laadt een Skills-snapshot
   - roept `runEmbeddedPiAgent` aan (pi-agent-core runtime)
   - zendt **lifecycle end/error** uit als de ingebedde lus er geen uitzendt
3. `runEmbeddedPiAgent`:
   - serializeert runs via per-sessie- en globale wachtrijen
   - resolveert model + auth-profiel en bouwt de pi-sessie
   - abonneert zich op pi-events en streamt assistant/tool-delta’s
   - forceert time-out -> abortussen indien overschreden
   - retourneert payloads + usage-metadata
4. `subscribeEmbeddedPiSession` overbrugt pi-agent-core-events naar de OpenClaw `agent`-stream:
   - tool-events ⇒ `stream: "tool"`
   - assistant-delta’s ⇒ `stream: "assistant"`
   - levenscyclusgebeurtenissen ⇒ `stream: "lifecycle"` (`phase: "start" | "end" | "error"`)
5. `agent.wait` gebruikt `waitForAgentJob`:
   - wacht op **lifecycle end/error** voor `runId`
   - retourneert `{ status: ok|error|timeout, startedAt, endedAt, error? }`

## Wachtrij + concurrency

- Runs worden geserialiseerd per sessiesleutel (sessielane) en optioneel via een globale lane.
- Dit voorkomt tool-/sessieraces en houdt de sessiegeschiedenis consistent.
- Berichtkanalen kunnen wachtrijmodi kiezen (collect/steer/followup) die dit lanesysteem voeden.
  Zie [Command Queue](/concepts/queue).

## Sessie- en werkruimtevoorbereiding

- De werkruimte wordt geresolveerd en aangemaakt; gesandboxed runs kunnen omleiden naar een sandbox-werkruimteroot.
- Skills worden geladen (of hergebruikt vanuit een snapshot) en in env en prompt geïnjecteerd.
- Bootstrap-/contextbestanden worden geresolveerd en in het systeemprompt-rapport geïnjecteerd.
- Er wordt een schrijflock op de sessie verkregen; `SessionManager` wordt geopend en voorbereid vóór het streamen.

## Promptopbouw + systeemprompt

- De systeemprompt wordt opgebouwd uit de basisprompt van OpenClaw, de Skills-prompt, bootstrapcontext en per-run overrides.
- Modelspecificieke limieten en compaction-reservetokens worden afgedwongen.
- Zie [System prompt](/concepts/system-prompt) voor wat het model ziet.

## Hook-punten (waar je kunt onderscheppen)

OpenClaw heeft twee hooksystemen:

- **Interne hooks** (Gateway-hooks): eventgedreven scripts voor opdrachten en levenscyclusgebeurtenissen.
- **Plugin-hooks**: uitbreidingspunten binnen de agent-/toollevenscyclus en de Gateway-pijplijn.

### Interne hooks (Gateway-hooks)

- **`agent:bootstrap`**: draait tijdens het bouwen van bootstrapbestanden voordat de systeemprompt is afgerond.
  Gebruik dit om bootstrapcontextbestanden toe te voegen of te verwijderen.
- **Command hooks**: `/new`, `/reset`, `/stop` en andere command-events (zie Hooks-documentatie).

Zie [Hooks](/automation/hooks) voor installatie en voorbeelden.

### Plugin-hooks (agent- + Gateway-levenscyclus)

Deze draaien binnen de agentlus of de Gateway-pijplijn:

- **`before_agent_start`**: injecteert context of overschrijft de systeemprompt vóórdat de run start.
- **`agent_end`**: inspecteert de definitieve berichtenlijst en runmetadata na voltooiing.
- **`before_compaction` / `after_compaction`**: observeert of annoteert compaction-cycli.
- **`before_tool_call` / `after_tool_call`**: onderschept toolparameters/-resultaten.
- **`tool_result_persist`**: transformeert toolresultaten synchroon voordat ze in het sessietranscript worden geschreven.
- **`message_received` / `message_sending` / `message_sent`**: inbound- en outbound-berichthooks.
- **`session_start` / `session_end`**: grenzen van de sessielevenscyclus.
- **`gateway_start` / `gateway_stop`**: Gateway-levenscyclusgebeurtenissen.

Zie [Plugins](/tools/plugin#plugin-hooks) voor de hook-API en registratiedetails.

## Streaming + gedeeltelijke antwoorden

- Assistant-delta’s worden gestreamd vanuit pi-agent-core en uitgezonden als `assistant`-events.
- Blokstreaming kan gedeeltelijke antwoorden uitzenden op `text_end` of `message_end`.
- Reasoning-streaming kan als een aparte stream of als blokantwoorden worden uitgezonden.
- Zie [Streaming](/concepts/streaming) voor chunking- en blokantwoordgedrag.

## Toolexecutie + messagingtools

- Tool start/update/end-events worden uitgezonden op de `tool`-stream.
- Toolresultaten worden geschoond op grootte en afbeeldingspayloads vóór loggen/uitzenden.
- Verzendingen door messagingtools worden gevolgd om dubbele assistantbevestigingen te onderdrukken.

## Antwoordvormgeving + onderdrukking

- Definitieve payloads worden samengesteld uit:
  - assistanttekst (en optionele reasoning)
  - inline toolsamenvattingen (wanneer verbose + toegestaan)
  - assistantfouttekst wanneer het model faalt
- `NO_REPLY` wordt behandeld als een stil token en gefilterd uit uitgaande payloads.
- Duplicaten van messagingtools worden verwijderd uit de definitieve payloadlijst.
- Als er geen renderbare payloads overblijven en een tool faalde, wordt een fallback-toolfoutantwoord uitgezonden
  (tenzij een messagingtool al een voor de gebruiker zichtbaar antwoord heeft verzonden).

## Compaction + retries

- Auto-compaction zendt `compaction`-streamevents uit en kan een retry triggeren.
- Bij retry worden in-memory buffers en toolsamenvattingen gereset om dubbele uitvoer te voorkomen.
- Zie [Compaction](/concepts/compaction) voor de compaction-pijplijn.

## Eventstreams (vandaag)

- `lifecycle`: uitgezonden door `subscribeEmbeddedPiSession` (en als fallback door `agentCommand`)
- `assistant`: gestreamde delta’s van pi-agent-core
- `tool`: gestreamde tool-events van pi-agent-core

## Chatkanaalafhandeling

- Assistant-delta’s worden gebufferd tot chat `delta`-berichten.
- Een chat `final` wordt uitgezonden bij **lifecycle end/error**.

## Time-outs

- `agent.wait` standaard: 30 s (alleen het wachten). Parameter `timeoutMs` overschrijft dit.
- Agent-runtime: `agents.defaults.timeoutSeconds` standaard 600 s; afgedwongen in `runEmbeddedPiAgent`-aborttimer.

## Waar dingen vroegtijdig kunnen eindigen

- Agent-time-out (afbreken)
- AbortSignal (annuleren)
- Gateway-ontkoppeling of RPC-time-out
- `agent.wait`-time-out (alleen wachten; stopt de agent niet)
