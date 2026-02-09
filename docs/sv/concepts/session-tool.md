---
summary: "Agentsessionverktyg för att lista sessioner, hämta historik och skicka meddelanden mellan sessioner"
read_when:
  - Lägga till eller ändra sessionsverktyg
title: "Sessionsverktyg"
---

# Sessionsverktyg

Mål: ett litet verktygsset som är svårt att missbruka, så att agenter kan lista sessioner, hämta historik och skicka till en annan session.

## Verktygsnamn

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

## Nyckelmodell

- Huvudbehållaren för direktchatt är alltid den bokstavliga nyckeln `"main"` (löses till den aktuella agentens huvudnyckel).
- Gruppchattar använder `agent:<agentId>:<channel>:group:<id>` eller `agent:<agentId>:<channel>:channel:<id>` (skicka hela nyckeln).
- Cron-jobb använder `cron:<job.id>`.
- Hooks använder `hook:<uuid>` om inget annat uttryckligen anges.
- Node-sessioner använder `node-<nodeId>` om inget annat uttryckligen anges.

`global` och `okänd` är reserverade värden och listas aldrig. Om `session.scope = "global"`, alias vi det till `main` för alla verktyg så att den som ringer aldrig ser `global`.

## sessions_list

Lista sessioner som en array av rader.

Parametrar:

- `kinds?: string[]` filter: någon av `"main" | "group" | "cron" | "hook" | "node" | "other"`
- `limit?: number` max rader (standard: serverstandard, klampas t.ex. 200)
- `activeMinutes?: number` endast sessioner uppdaterade inom N minuter
- `messageLimit?: number` 0 = inga meddelanden (standard 0); >0 = inkludera de senaste N meddelandena

Beteende:

- `messageLimit > 0` hämtar `chat.history` per session och inkluderar de senaste N meddelandena.
- Verktygsresultat filtreras bort i listutdata; använd `sessions_history` för verktygsmeddelanden.
- När det körs i en **sandboxed** agentsession, har sessionsverktyg som standard **endast-skapade-synlighet** (se nedan).

Radformat (JSON):

- `key`: sessionsnyckel (sträng)
- `kind`: `main | group | cron | hook | node | other`
- `channel`: `whatsapp | telegram | discord | signal | imessage | webchat | internal | unknown`
- `displayName` (gruppvisningsetikett om tillgänglig)
- `updatedAt` (ms)
- `sessionId`
- `model`, `contextTokens`, `totalTokens`
- `thinkingLevel`, `verboseLevel`, `systemSent`, `abortedLastRun`
- `sendPolicy` (sessionsöverskrivning om satt)
- `lastChannel`, `lastTo`
- `deliveryContext` (normaliserad `{ channel, to, accountId }` när tillgänglig)
- `transcriptPath` (bästa-försök-sökväg härledd från lagringskatalog + sessionId)
- `messages?` (endast när `messageLimit > 0`)

## sessions_history

Hämta transkript för en session.

Parametrar:

- `sessionKey` (obligatorisk; accepterar sessionsnyckel eller `sessionId` från `sessions_list`)
- `limit?: number` max meddelanden (servern klampar)
- `includeTools?: boolean` (standard false)

Beteende:

- `includeTools=false` filtrerar `role: "toolResult"`-meddelanden.
- Returnerar meddelandearray i rått transkriptformat.
- När en `sessionId` anges, löser OpenClaw den till motsvarande sessionsnyckel (fel vid saknade id:n).

## sessions_send

Skicka ett meddelande till en annan session.

Parametrar:

- `sessionKey` (obligatorisk; accepterar sessionsnyckel eller `sessionId` från `sessions_list`)
- `message` (obligatorisk)
- `timeoutSeconds?: number` (standard >0; 0 = fire-and-forget)

Beteende:

- `timeoutSeconds = 0`: köa och returnera `{ runId, status: "accepted" }`.
- `timeoutSeconds > 0`: vänta upp till N sekunder på slutförande och returnera sedan `{ runId, status: "ok", reply }`.
- Om väntetider ut: `{ runId, status: "timeout", fel }`. Kör fortsätter; anrop `sessions_history` senare.
- Om körningen misslyckas: `{ runId, status: "error", error }`.
- Leveransannonser körs efter att primärkörningen slutförts och är best-effort; `status: "ok"` garanterar inte att annonsen levererades.
- Väntar via gateway `agent.wait` (serversidan) så att återanslutningar inte avbryter väntan.
- Agent-till-agent-meddelandekontext injiceras för primärkörningen.
- Efter att primärkörningen slutförts kör OpenClaw en **reply-back-loop**:
  - Runda 2+ alternerar mellan begärande och målagent.
  - Svara exakt `REPLY_SKIP` för att stoppa ping‑pong.
  - Max antal turer är `session.agentToAgent.maxPingPongTurns` (0–5, standard 5).
- När loopen avslutas kör OpenClaw steget **agent‑till‑agent‑announce** (endast målagent):
  - Svara exakt `ANNOUNCE_SKIP` för att vara tyst.
  - Alla andra svar skickas till målkanalen.
  - Announce-steget inkluderar den ursprungliga begäran + runda‑1‑svaret + senaste ping‑pong‑svaret.

## Kanalfält

- För grupper är `channel` den kanal som registreras på sessionsposten.
- För direktchattar mappar `channel` från `lastChannel`.
- För cron/hook/node är `channel` `internal`.
- Om den saknas är `channel` `unknown`.

## Säkerhet / Sändpolicy

Policybaserad blockering efter kanal-/chatttyp (inte per sessions-id).

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

Körningsöverskrivning (per sessionspost):

- `sendPolicy: "allow" | "deny"` (osatt = ärv konfig)
- Kan sättas via `sessions.patch` eller ägarendast `/send on|off|inherit` (fristående meddelande).

Tillämpningspunkter:

- `chat.send` / `agent` (gateway)
- logik för automatisk svarleverans

## sessions_spawn

Starta en sub-agentkörning i en isolerad session och annonsera resultatet tillbaka till den begärande chattkanalen.

Parametrar:

- `task` (obligatorisk)
- `label?` (valfri; används för loggar/UI)
- `agentId?` (valfri; starta under ett annat agent-id om tillåtet)
- `model?` (valfri; åsidosätter sub-agentmodellen; ogiltiga värden ger fel)
- `runTimeoutSeconds?` (standard 0; när satt avbryts sub-agentkörningen efter N sekunder)
- `cleanup?` (`delete|keep`, standard `keep`)

Tillåtelselista:

- `agents.list[].subagents.allowAgents`: lista över agent-ID som tillåts via `agentId` (`["*"]` för att tillåta någon). Standard: endast beställaren agent.

Discovery:

- Använd `agents_list` för att upptäcka vilka agent-id:n som är tillåtna för `sessions_spawn`.

Beteende:

- Startar en ny `agent:<agentId>:subagent:<uuid>`-session med `deliver: false`.
- Sub-agenter använder som standard hela verktygsuppsättningen **minus sessionsverktyg** (konfigurerbart via `tools.subagents.tools`).
- Sub-agenter får inte anropa `sessions_spawn` (ingen sub-agent → sub-agent-start).
- Alltid icke-blockerande: returnerar `{ status: "accepted", runId, childSessionKey }` omedelbart.
- Efter slutförande kör OpenClaw ett **announce-steg** för sub-agenten och publicerar resultatet till den begärande chattkanalen.
- Svara exakt `ANNOUNCE_SKIP` under announce-steget för att vara tyst.
- Announce-svar normaliseras till `Status`/`Result`/`Notes`; `Status` kommer från körningsutfallet (inte modelltext).
- Sub-agentsessioner arkiveras automatiskt efter `agents.defaults.subagents.archiveAfterMinutes` (standard: 60).
- Announce-svar inkluderar en statistikrad (körtid, tokens, sessionKey/sessionId, transkriptsökväg och valfri kostnad).

## Sandbox-sessioners synlighet

Sandboxed-sessioner kan använda sessionsverktyg, men som standard ser de bara sessioner som de startat via `sessions_spawn`.

Konfig:

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
