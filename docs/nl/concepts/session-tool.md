---
summary: "Agent-sessietools voor het weergeven van sessies, het ophalen van geschiedenis en het verzenden van berichten tussen sessies"
read_when:
  - Sessietools toevoegen of wijzigen
title: "Sessietools"
---

# Sessietools

Doel: een kleine, moeilijk verkeerd te gebruiken toolset zodat agents sessies kunnen weergeven, geschiedenis kunnen ophalen en naar een andere sessie kunnen verzenden.

## Toolnamen

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

## Sleutelmodel

- De hoofd direct-chat bucket is altijd de letterlijke sleutel `"main"` (opgelost naar de hoofdsleutel van de huidige agent).
- Groepschats gebruiken `agent:<agentId>:<channel>:group:<id>` of `agent:<agentId>:<channel>:channel:<id>` (geef de volledige sleutel door).
- Cron-jobs gebruiken `cron:<job.id>`.
- Hooks gebruiken `hook:<uuid>`, tenzij expliciet ingesteld.
- Node-sessies gebruiken `node-<nodeId>`, tenzij expliciet ingesteld.

`global` en `unknown` zijn gereserveerde waarden en worden nooit weergegeven. Als `session.scope = "global"`, aliassen we dit naar `main` voor alle tools zodat aanroepers nooit `global` zien.

## sessions_list

Geef sessies weer als een array van rijen.

Parameters:

- `kinds?: string[]` filter: een van `"main" | "group" | "cron" | "hook" | "node" | "other"`
- `limit?: number` maximaal aantal rijen (standaard: serverstandaard, begrensd tot bijv. 200)
- `activeMinutes?: number` alleen sessies die binnen N minuten zijn bijgewerkt
- `messageLimit?: number` 0 = geen berichten (standaard 0); >0 = laatste N berichten opnemen

Gedrag:

- `messageLimit > 0` haalt `chat.history` per sessie op en neemt de laatste N berichten op.
- Toolresultaten worden uit de lijstuitvoer gefilterd; gebruik `sessions_history` voor toolberichten.
- Bij uitvoering in een **gesandboxde** agentsessie staan sessietools standaard op **alleen-gespawnede zichtbaarheid** (zie hieronder).

Rijstructuur (JSON):

- `key`: sessiesleutel (string)
- `kind`: `main | group | cron | hook | node | other`
- `channel`: `whatsapp | telegram | discord | signal | imessage | webchat | internal | unknown`
- `displayName` (groepsweergavelabel indien beschikbaar)
- `updatedAt` (ms)
- `sessionId`
- `model`, `contextTokens`, `totalTokens`
- `thinkingLevel`, `verboseLevel`, `systemSent`, `abortedLastRun`
- `sendPolicy` (sessie-override indien ingesteld)
- `lastChannel`, `lastTo`
- `deliveryContext` (genormaliseerde `{ channel, to, accountId }` indien beschikbaar)
- `transcriptPath` (best-effort pad afgeleid van store-dir + sessionId)
- `messages?` (alleen wanneer `messageLimit > 0`)

## sessions_history

Haal het transcript op voor één sessie.

Parameters:

- `sessionKey` (vereist; accepteert sessiesleutel of `sessionId` uit `sessions_list`)
- `limit?: number` maximaal aantal berichten (server begrenst)
- `includeTools?: boolean` (standaard false)

Gedrag:

- `includeTools=false` filtert `role: "toolResult"`-berichten.
- Retourneert een berichtenarray in het ruwe transcriptformaat.
- Bij een opgegeven `sessionId` lost OpenClaw dit op naar de bijbehorende sessiesleutel (fout bij ontbrekende id’s).

## sessions_send

Verstuur een bericht naar een andere sessie.

Parameters:

- `sessionKey` (vereist; accepteert sessiesleutel of `sessionId` uit `sessions_list`)
- `message` (vereist)
- `timeoutSeconds?: number` (standaard >0; 0 = fire-and-forget)

Gedrag:

- `timeoutSeconds = 0`: in de wachtrij plaatsen en `{ runId, status: "accepted" }` retourneren.
- `timeoutSeconds > 0`: maximaal N seconden wachten op voltooiing en daarna `{ runId, status: "ok", reply }` retourneren.
- Als wachten verloopt: `{ runId, status: "timeout", error }`. De run gaat door; roep `sessions_history` later aan.
- Als de run faalt: `{ runId, status: "error", error }`.
- Aankondigingsruns na aflevering worden uitgevoerd nadat de primaire run is voltooid en zijn best-effort; `status: "ok"` garandeert niet dat de aankondiging is afgeleverd.
- Wacht via gateway `agent.wait` (server-side) zodat reconnects het wachten niet onderbreken.
- Agent-naar-agent berichtcontext wordt geïnjecteerd voor de primaire run.
- Nadat de primaire run is voltooid, start OpenClaw een **reply-back loop**:
  - Ronde 2+ wisselt af tussen de aanvragende en doelagent.
  - Antwoord exact `REPLY_SKIP` om de ping‑pong te stoppen.
  - Maximaal aantal beurten is `session.agentToAgent.maxPingPongTurns` (0–5, standaard 5).
- Zodra de loop eindigt, voert OpenClaw de **agent-naar-agent aankondigingsstap** uit (alleen doelagent):
  - Antwoord exact `ANNOUNCE_SKIP` om stil te blijven.
  - Elk ander antwoord wordt naar het doelkanaal verzonden.
  - De aankondigingsstap bevat het oorspronkelijke verzoek + antwoord van ronde 1 + het laatste ping‑pong-antwoord.

## Kanaal veld

- Voor groepen is `channel` het kanaal dat op de sessie-entry is vastgelegd.
- Voor directe chats mapt `channel` vanaf `lastChannel`.
- Voor cron/hook/node is `channel` `internal`.
- Indien ontbrekend, is `channel` `unknown`.

## Beveiliging / Verzendbeleid

Beleidsgebaseerde blokkering per kanaal/chat-type (niet per sessie-id).

```json
{
  "session": {
    "sendPolicy": {
      "rules": [
        {
          "match": { "channel": "discord", "chatType": "group" },
          "action": "deny"
        }
      ],
      "default": "allow"
    }
  }
}
```

Runtime-override (per sessie-entry):

- `sendPolicy: "allow" | "deny"` (niet ingesteld = configuratie erven)
- Instelbaar via `sessions.patch` of eigenaar-only `/send on|off|inherit` (op zichzelf staand bericht).

Handhavingspunten:

- `chat.send` / `agent` (Gateway)
- auto-reply afleverlogica

## sessions_spawn

Start een sub-agent run in een geïsoleerde sessie en kondig het resultaat aan in het chatkanaal van de aanvrager.

Parameters:

- `task` (vereist)
- `label?` (optioneel; gebruikt voor logs/UI)
- `agentId?` (optioneel; spawn onder een andere agent-id indien toegestaan)
- `model?` (optioneel; overschrijft het sub-agentmodel; ongeldige waarden geven een fout)
- `runTimeoutSeconds?` (standaard 0; indien ingesteld wordt de sub-agent run na N seconden afgebroken)
- `cleanup?` (`delete|keep`, standaard `keep`)

Toegestane lijst:

- `agents.list[].subagents.allowAgents`: lijst met agent-id’s die zijn toegestaan via `agentId` (`["*"]` om alles toe te staan). Standaard: alleen de aanvragende agent.

Discovery:

- Gebruik `agents_list` om te ontdekken welke agent-id’s zijn toegestaan voor `sessions_spawn`.

Gedrag:

- Start een nieuwe `agent:<agentId>:subagent:<uuid>`-sessie met `deliver: false`.
- Sub-agents gebruiken standaard de volledige toolset **minus sessietools** (configureerbaar via `tools.subagents.tools`).
- Sub-agents mogen `sessions_spawn` niet aanroepen (geen sub-agent → sub-agent spawning).
- Altijd niet-blokkerend: retourneert `{ status: "accepted", runId, childSessionKey }` onmiddellijk.
- Na voltooiing voert OpenClaw een sub-agent **aankondigingsstap** uit en plaatst het resultaat in het chatkanaal van de aanvrager.
- Antwoord exact `ANNOUNCE_SKIP` tijdens de aankondigingsstap om stil te blijven.
- Aankondigingsantwoorden worden genormaliseerd naar `Status`/`Result`/`Notes`; `Status` komt uit de runtime-uitkomst (niet uit de modeltekst).
- Sub-agent sessies worden automatisch gearchiveerd na `agents.defaults.subagents.archiveAfterMinutes` (standaard: 60).
- Aankondigingsantwoorden bevatten een statistiekregel (runtime, tokens, sessionKey/sessionId, transcriptpad en optionele kosten).

## Sandbox-sessiezichtbaarheid

Gesandboxde sessies kunnen sessietools gebruiken, maar zien standaard alleen sessies die zij hebben gespawned via `sessions_spawn`.

Config:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        // default: "spawned"
        sessionToolsVisibility: "spawned", // or "all"
      },
    },
  },
}
```
