---
summary: "Agent-sessionværktøjer til at liste sessioner, hente historik og sende beskeder på tværs af sessioner"
read_when:
  - Tilføjelse eller ændring af session tools
title: "Session Tools"
---

# Session Tools

Mål: et lille, svært-at-misbruge sæt værktøjer, så agenter kan liste sessioner, hente historik og sende til en anden session.

## Tool Names

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

## Key Model

- Den primære direkte chat-bucket er altid den bogstavelige nøgle `"main"` (opløst til den aktuelle agents primære nøgle).
- Gruppechats bruger `agent:<agentId>:<channel>:group:<id>` eller `agent:<agentId>:<channel>:channel:<id>` (angiv den fulde nøgle).
- Cron-jobs bruger `cron:<job.id>`.
- Hooks bruger `hook:<uuid>`, medmindre andet er angivet eksplicit.
- Node-sessioner bruger `node-<nodeId>`, medmindre andet er angivet eksplicit.

`global` og `ukendt` er reserverede værdier og er aldrig listet. If `session.scope = "global"`, we alias it to `main` for all tools so callers never see `global`.

## sessions_list

List sessioner som et array af rækker.

Parametre:

- `kinds?: string[]` filter: en af `"main" | "group" | "cron" | "hook" | "node" | "other"`
- `limit?: number` max rækker (standard: serverstandard, tang, f.eks. 200)
- `activeMinutes?: number` kun sessioner opdateret inden for N minutter
- `messageLimit?: number` 0 = ingen beskeder (standard 0); >0 = inkluder de seneste N beskeder

Adfærd:

- `messageLimit > 0` henter `chat.history` pr. session og inkluderer de seneste N beskeder.
- Tool-resultater filtreres fra i listeoutput; brug `sessions_history` for tool-beskeder.
- Når der køres i en **sandboxed** agent-session, er session tools som standard **kun-skapte synlighed** (se nedenfor).

Rækkeform (JSON):

- `key`: sessionsnøgle (string)
- `kind`: `main | group | cron | hook | node | other`
- `channel`: `whatsapp | telegram | discord | signal | imessage | webchat | internal | unknown`
- `displayName` (gruppens visningslabel, hvis tilgængelig)
- `updatedAt` (ms)
- `sessionId`
- `model`, `contextTokens`, `totalTokens`
- `thinkingLevel`, `verboseLevel`, `systemSent`, `abortedLastRun`
- `sendPolicy` (session-override hvis sat)
- `lastChannel`, `lastTo`
- `deliveryContext` (normaliseret `{ channel, to, accountId }` når tilgængelig)
- `transcriptPath` (best-effort sti afledt af store-dir + sessionId)
- `messages?` (kun når `messageLimit > 0`)

## sessions_history

Hent transkript for én session.

Parametre:

- `sessionKey` (påkrævet; accepterer sessionsnøgle eller `sessionId` fra `sessions_list`)
- `grænse?: nummer` maks beskeder (server tangs)
- `includeTools?: boolean` (standard false)

Adfærd:

- `includeTools=false` filtrerer `role: "toolResult"` beskeder.
- Returnerer et besked-array i rå transkriptformat.
- Når der gives en `sessionId`, opløser OpenClaw den til den tilsvarende sessionsnøgle (manglende id’er giver fejl).

## sessions_send

Send en besked ind i en anden session.

Parametre:

- `sessionKey` (påkrævet; accepterer sessionsnøgle eller `sessionId` fra `sessions_list`)
- `message` (påkrævet)
- `timeoutSeconds?: number` (standard >0; 0 = fire-and-forget)

Adfærd:

- `timeoutSeconds = 0`: sæt i kø og returnér `{ runId, status: "accepted" }`.
- `timeoutSeconds > 0`: vent op til N sekunder på færdiggørelse, og returnér derefter `{ runId, status: "ok", reply }`.
- Hvis ventetider ud: `{ runId, status: "timeout", error }`. Kør fortsætter; kald `sessions_history` senere.
- Hvis kørslen fejler: `{ runId, status: "error", error }`.
- Annonceringskørsler efter levering sker efter den primære kørsel er fuldført og er best-effort; `status: "ok"` garanterer ikke, at annoncen blev leveret.
- Venter via gateway `agent.wait` (server-side), så genforbindelser ikke afbryder ventetiden.
- Agent-til-agent beskedkontekst injiceres for den primære kørsel.
- Efter den primære kørsel er fuldført, kører OpenClaw en **reply-back loop**:
  - Runde 2+ skifter mellem anmoder- og målagent.
  - Svar præcist `REPLY_SKIP` for at stoppe ping‑pong.
  - Maks. drejninger er `session.agentToAgent.maxPingPongTurns` (0–5, standard 5).
- Når løkken slutter, kører OpenClaw **agent‑til‑agent announce step** (kun målagent):
  - Svar præcist `ANNOUNCE_SKIP` for at forblive tavs.
  - Ethvert andet svar sendes til målkanalen.
  - Announce-trinnet inkluderer den oprindelige anmodning + svar fra runde 1 + seneste ping‑pong‑svar.

## Channel Field

- For grupper er `channel` den kanal, der er registreret på sessionsposten.
- For direkte chats mapper `channel` fra `lastChannel`.
- For cron/hook/node er `channel` `internal`.
- Hvis den mangler, er `channel` `unknown`.

## Security / Send Policy

Politikbaseret blokering efter kanal/chat-type (ikke pr. sessions-id).

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

Runtime-override (pr. sessionspost):

- `sendPolicy: "allow" | "deny"` (ikke sat = arver konfiguration)
- Kan sættes via `sessions.patch` eller ejer-kun `/send on|off|inherit` (standalone-besked).

Håndhævelsespunkter:

- `chat.send` / `agent` (gateway)
- auto-svar leveringslogik

## sessions_spawn

Spawn en sub-agent-kørsel i en isoleret session og annoncér resultatet tilbage til anmoderens chatkanal.

Parametre:

- `task` (påkrævet)
- `label?` (valgfri; bruges til logs/UI)
- `agentId?` (valgfri; spawn under et andet agent-id, hvis tilladt)
- `model?` (valgfri; overskriver sub-agent-modellen; ugyldige værdier giver fejl)
- `runTimeoutSeconds?` (standard 0; når sat, afbrydes sub-agent-kørslen efter N sekunder)
- `cleanup?` (`delete|keep`, standard `keep`)

Tilladelsesliste:

- `agents.list[].subagents.allowAgents`: liste over agenter tilladt via `agentId` (`["*"]` for at tillade nogen). Standard: kun anmoderen.

Discovery:

- Brug `agents_list` til at finde ud af, hvilke agent-id’er der er tilladt for `sessions_spawn`.

Adfærd:

- Starter en ny `agent:<agentId>:subagent:<uuid>`-session med `deliver: false`.
- Sub-agenter har som standard det fulde tool-sæt **minus session tools** (kan konfigureres via `tools.subagents.tools`).
- Sub-agenter må ikke kalde `sessions_spawn` (ingen sub-agent → sub-agent spawning).
- Altid ikke-blokerende: returnerer `{ status: "accepted", runId, childSessionKey }` med det samme.
- Efter fuldførelse kører OpenClaw et sub-agent **announce step** og poster resultatet til anmoderens chatkanal.
- Svar præcist `ANNOUNCE_SKIP` under announce-trinnet for at forblive tavs.
- Announce-svar normaliseres til `Status`/`Result`/`Notes`; `Status` kommer fra runtime-udfald (ikke modeltekst).
- Sub-agent-sessioner arkiveres automatisk efter `agents.defaults.subagents.archiveAfterMinutes` (standard: 60).
- Annonceringssvar omfatter en statistik linje (runtime, tokens, sessionKey/sessionId, udskrift sti, og valgfri omkostninger).

## Sandbox Session Visibility

Sandboxed sessioner kan bruge session tools, men som standard ser de kun sessioner, de har spawned via `sessions_spawn`.

Konfiguration:

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
