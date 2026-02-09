---
summary: "Sub-agenter: starta isolerade agentkörningar som annonserar resultat tillbaka till den begärande chatten"
read_when:
  - Du vill ha bakgrunds-/parallellt arbete via agenten
  - Du ändrar sessions_spawn eller policy för sub-agentverktyg
title: "Sub-agenter"
---

# Sub-agenter

Sub-agenter är bakgrundsagenter körs lekte från en befintlig agent kör. De kör i sin egen session (`agent:<agentId>:subagent:<uuid>`) och när de är klara \*\*meddelar de sina resultat tillbaka till den begärda chattkanalen.

## Slash-kommando

Använd `/subagents` för att inspektera eller styra sub-agentkörningar för den **aktuella sessionen**:

- `/subagents list`
- `/subagents stop <id|#|all>`
- `/subagents log <id|#> [limit] [tools]`
- `/subagents info <id|#>`
- `/subagents send <id|#> <message>`

`/subagents info` visar körningsmetadata (status, tidsstämplar, sessions-id, transkriptionssökväg, rensning).

Primära mål:

- Parallellisera arbete av typen ”research / lång uppgift / långsamt verktyg” utan att blockera huvudkörningen.
- Hålla sub-agenter isolerade som standard (sessionsseparering + valfri sandboxing).
- Göra verktygsytan svår att missbruka: sub-agenter får **inte** sessionverktyg som standard.
- Undvika nästlad fan-out: sub-agenter kan inte starta sub-agenter.

Kostnadsanmärkning: varje underagent har sin **egna** kontext och användning av token. För tunga eller repetitiva
uppgifter, ange en billigare modell för underagenter och hålla din huvudagent på en högre kvalitet modell.
Du kan konfigurera detta via `agents.defaults.subagents.model` eller per-agent åsidosätter.

## Verktyg

Använd `sessions_spawn`:

- Startar en sub-agentkörning (`deliver: false`, global körfil: `subagent`)
- Kör sedan ett announce-steg och postar announce-svaret till den begärande chattkanalen
- Standardmodell: ärvs från anroparen om du inte sätter `agents.defaults.subagents.model` (eller per-agent `agents.list[].subagents.model`); ett explicit `sessions_spawn.model` vinner alltid.
- Standardtänkande: ärvs från anroparen om du inte sätter `agents.defaults.subagents.thinking` (eller per-agent `agents.list[].subagents.thinking`); ett explicit `sessions_spawn.thinking` vinner alltid.

Verktygsparametrar:

- `task` (obligatorisk)
- `label?` (valfri)
- `agentId?` (valfri; starta under ett annat agent-id om tillåtet)
- `model?` (valfri; åsidosätter sub-agentens modell; ogiltiga värden hoppas över och sub-agenten kör på standardmodellen med en varning i verktygsresultatet)
- `thinking?` (valfri; åsidosätter tänknivå för sub-agentkörningen)
- `runTimeoutSeconds?` (standard `0`; när satt avbryts sub-agentkörningen efter N sekunder)
- `cleanup?` (`delete|keep`, standard `keep`)

Tillåtelselista:

- `agents.list[].subagents.allowAgents`: lista över agent-id som kan riktas via `agentId` (`["*"]` för att tillåta någon). Standard: endast beställaren agent.

Discovery:

- Använd `agents_list` för att se vilka agent-id:n som för närvarande är tillåtna för `sessions_spawn`.

Autoarkivering:

- Sub-agentsessioner arkiveras automatiskt efter `agents.defaults.subagents.archiveAfterMinutes` (standard: 60).
- Arkivet använder `sessions.delete` och byter namn på utskriften till `*.deleted.<timestamp>` (samma mapp).
- `cleanup: "delete"` arkiverar omedelbart efter announce (behåller fortfarande transkriptet via namnbyte).
- Autoarkivering är best-effort; väntande timers går förlorade om gateway (nätverksgateway) startas om.
- `runTimeoutSeconds` gör **inte** auto-arkivet; det stoppar bara körningen. Sessionen återstår till auto-arkiv.

## Autentisering

Sub-agentautentisering löses via **agent-id**, inte via sessionstyp:

- Sub-agentens sessionsnyckel är `agent:<agentId>:subagent:<uuid>`.
- Autentiseringslagret laddas från den agentens `agentDir`.
- Huvudagentens autentiseringsprofiler slås samman som **fallback**; agentprofiler åsidosätter huvudprofiler vid konflikter.

Obs: sammanslagningen är tillsats, så huvudprofiler är alltid tillgängliga som reservdelar. Helt isolerad auth per agent stöds ännu inte.

## Announce

Sub-agenter rapporterar tillbaka via ett announce-steg:

- Announce-steget körs inne i sub-agentsessionen (inte den begärande sessionen).
- Om sub-agenten svarar exakt `ANNOUNCE_SKIP`, postas ingenting.
- Annars postas announce-svaret till den begärande chattkanalen via ett uppföljande `agent`-anrop (`deliver=true`).
- Announce-svar bevarar tråd-/ämnesroutning när det finns (Slack-trådar, Telegram-ämnen, Matrix-trådar).
- Announce-meddelanden normaliseras till en stabil mall:
  - `Status:` härleds från körningsutfallet (`success`, `error`, `timeout` eller `unknown`).
  - `Result:` sammanfattningsinnehållet från announce-steget (eller `(not available)` om det saknas).
  - `Notes:` feldetaljer och annan användbar kontext.
- `Status` härleds inte från modellutdata; den kommer från körningsutfallssignaler.

Announce-payloads inkluderar en statistikrads längst ned (även när de är inbäddade):

- Körtid (t.ex., `runtime 5m12s`)
- Tokenförbrukning (in/ut/totalt)
- Uppskattad kostnad när modellprissättning är konfigurerad (`models.providers.*.models[].cost`)
- `sessionKey`, `sessionId` och transkriptionssökväg (så att huvudagenten kan hämta historik via `sessions_history` eller inspektera filen på disk)

## Verktygspolicy (sub-agentverktyg)

Som standard får sub-agenter **alla verktyg utom sessionverktyg**:

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

Åsidosätt via konfig:

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

## Samtidighet

Sub-agenter använder en dedikerad in-process-körfil:

- Körfilens namn: `subagent`
- Samtidighet: `agents.defaults.subagents.maxConcurrent` (standard `8`)

## Stopp

- Att skicka `/stop` i den begärande chatten avbryter den begärande sessionen och stoppar alla aktiva sub-agentkörningar som startats från den.

## Begränsningar

- Underagent tillkännage är **bäst-ansträngning**. Om gatewayen startas om, i avvaktan på “announce back” arbete är förlorat.
- Sub-agenter delar fortfarande samma gatewayprocessresurser; behandla `maxConcurrent` som en säkerhetsventil.
- `sessions_spawn` är alltid icke-blockerande: den returnerar `{ status: "accepted", runId, childSessionKey }` omedelbart.
- Sub-agentens kontext injicerar endast `AGENTS.md` + `TOOLS.md` (ingen `SOUL.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md` eller `BOOTSTRAP.md`).
