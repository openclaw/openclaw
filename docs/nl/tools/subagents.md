---
summary: "Sub-agents: het starten van geïsoleerde agentruns die resultaten terugmelden aan de aanvragende chat"
read_when:
  - Je wilt achtergrond-/parallel werk via de agent
  - Je wijzigt sessions_spawn of het toolbeleid voor sub-agents
title: "Sub-agenten"
---

# Sub-agents

Sub-agents zijn achtergrond-agentruns die worden gestart vanuit een bestaande agentrun. Ze draaien in hun eigen sessie (`agent:<agentId>:subagent:<uuid>`) en **melden**, wanneer ze klaar zijn, hun resultaat terug aan het chatkanaal van de aanvrager.

## Slash-opdracht

Gebruik `/subagents` om sub-agentruns voor de **huidige sessie** te inspecteren of te beheren:

- `/subagents list`
- `/subagents stop <id|#|all>`
- `/subagents log <id|#> [limit] [tools]`
- `/subagents info <id|#>`
- `/subagents send <id|#> <message>`

`/subagents info` toont runmetadata (status, tijdstempels, sessie-id, transcriptpad, opschoning).

Primaire doelen:

- Paralleliseren van “onderzoek / lange taak / trage tool”-werk zonder de hoofd-run te blokkeren.
- Sub-agents standaard geïsoleerd houden (sessiescheiding + optionele sandboxing).
- Het tooloppervlak moeilijk te misbruiken houden: sub-agents krijgen standaard **geen** sessietools.
- Geneste fan-out vermijden: sub-agents kunnen geen sub-agents starten.

Kostenopmerking: elke sub-agent heeft zijn **eigen** context en tokengebruik. Voor zware of repetitieve
taken, stel een goedkoper model in voor sub-agents en houd je hoofdagent op een model van hogere kwaliteit.
Je kunt dit configureren via `agents.defaults.subagents.model` of via per-agent overrides.

## Tool

Gebruik `sessions_spawn`:

- Start een sub-agentrun (`deliver: false`, globale lane: `subagent`)
- Voert daarna een announce-stap uit en plaatst het announce-antwoord in het chatkanaal van de aanvrager
- Standaardmodel: erft van de aanroeper tenzij je `agents.defaults.subagents.model` instelt (of per-agent `agents.list[].subagents.model`); een expliciete `sessions_spawn.model` wint altijd.
- Standaard thinking: erft van de aanroeper tenzij je `agents.defaults.subagents.thinking` instelt (of per-agent `agents.list[].subagents.thinking`); een expliciete `sessions_spawn.thinking` wint altijd.

Toolparameters:

- `task` (vereist)
- `label?` (optioneel)
- `agentId?` (optioneel; starten onder een andere agent-id indien toegestaan)
- `model?` (optioneel; overschrijft het sub-agentmodel; ongeldige waarden worden overgeslagen en de sub-agent draait op het standaardmodel met een waarschuwing in het toolresultaat)
- `thinking?` (optioneel; overschrijft het thinking-niveau voor de sub-agentrun)
- `runTimeoutSeconds?` (standaard `0`; indien ingesteld wordt de sub-agentrun na N seconden afgebroken)
- `cleanup?` (`delete|keep`, standaard `keep`)

Toegestane lijst:

- `agents.list[].subagents.allowAgents`: lijst met agent-id’s die kunnen worden getarget via `agentId` (`["*"]` om iedereen toe te staan). Standaard: alleen de aanvragende agent.

Discovery:

- Gebruik `agents_list` om te zien welke agent-id’s momenteel zijn toegestaan voor `sessions_spawn`.

Automatisch archiveren:

- Sub-agentsessies worden automatisch gearchiveerd na `agents.defaults.subagents.archiveAfterMinutes` (standaard: 60).
- Archiveren gebruikt `sessions.delete` en hernoemt het transcript naar `*.deleted.<timestamp>` (zelfde map).
- `cleanup: "delete"` archiveert direct na announce (behoudt het transcript via hernoemen).
- Automatisch archiveren is best-effort; openstaande timers gaan verloren als de Gateway herstart.
- `runTimeoutSeconds` archiveert **niet** automatisch; het stopt alleen de run. De sessie blijft bestaan tot automatisch archiveren.

## Authenticatie

Sub-agentauthenticatie wordt bepaald op **agent-id**, niet op sessietype:

- De sub-agentsessiesleutel is `agent:<agentId>:subagent:<uuid>`.
- De auth store wordt geladen vanuit de `agentDir` van die agent.
- De authprofielen van de hoofdagent worden samengevoegd als **fallback**; agentprofielen overschrijven hoofdprofielen bij conflicten.

Let op: de samenvoeging is additief, dus hoofdprofielen blijven altijd beschikbaar als fallbacks. Volledig geïsoleerde authenticatie per agent wordt nog niet ondersteund.

## Announce

Sub-agents rapporteren terug via een announce-stap:

- De announce-stap draait binnen de sub-agentsessie (niet de sessie van de aanvrager).
- Als de sub-agent exact `ANNOUNCE_SKIP` antwoordt, wordt er niets geplaatst.
- Anders wordt het announce-antwoord geplaatst in het chatkanaal van de aanvrager via een vervolgaanroep van `agent` (`deliver=true`).
- Announce-antwoorden behouden thread-/topicroutering wanneer beschikbaar (Slack-threads, Telegram-topics, Matrix-threads).
- Announce-berichten worden genormaliseerd naar een stabiel sjabloon:
  - `Status:` afgeleid van de runuitkomst (`success`, `error`, `timeout` of `unknown`).
  - `Result:` de samenvattingsinhoud van de announce-stap (of `(not available)` indien ontbrekend).
  - `Notes:` foutdetails en andere nuttige context.
- `Status` wordt niet afgeleid van modeloutput; het komt uit runtime-uitkomstsignalen.

Announce-payloads bevatten aan het einde een statistiekenregel (zelfs wanneer verpakt):

- Runtijd (bijv. `runtime 5m12s`)
- Tokengebruik (invoer/uitvoer/totaal)
- Geschatte kosten wanneer modelprijzen zijn geconfigureerd (`models.providers.*.models[].cost`)
- `sessionKey`, `sessionId` en transcriptpad (zodat de hoofdagent de geschiedenis kan ophalen via `sessions_history` of het bestand op schijf kan inspecteren)

## Toolbeleid (sub-agenttools)

Standaard krijgen sub-agents **alle tools behalve sessietools**:

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

Overschrijven via config:

```json5
{
  agents: {
    defaults: {
      subagents: {
        maxConcurrent: 1,
      },
    },
  },
  tools: {
    subagents: {
      tools: {
        // deny wins
        deny: ["gateway", "cron"],
        // if allow is set, it becomes allow-only (deny still wins)
        // allow: ["read", "exec", "process"]
      },
    },
  },
}
```

## Concurrency

Sub-agents gebruiken een dedicated in-process queue-lane:

- Lanenaam: `subagent`
- Concurrency: `agents.defaults.subagents.maxConcurrent` (standaard `8`)

## Stoppen

- Het verzenden van `/stop` in de chat van de aanvrager breekt de aanvragersessie af en stopt alle actieve sub-agentruns die daaruit zijn gestart.

## Beperkingen

- Sub-agent announce is **best-effort**. Als de Gateway herstart, gaat uitstaand “announce terug”-werk verloren.
- Sub-agents delen nog steeds dezelfde Gateway-procesresources; behandel `maxConcurrent` als veiligheidsklep.
- `sessions_spawn` is altijd niet-blokkerend: het retourneert `{ status: "accepted", runId, childSessionKey }` onmiddellijk.
- Sub-agentcontext injecteert alleen `AGENTS.md` + `TOOLS.md` (geen `SOUL.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md` of `BOOTSTRAP.md`).
