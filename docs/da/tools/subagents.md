---
summary: "Sub-agenter: opstart af isolerede agentkørsler, der annoncerer resultater tilbage til anmoderens chat"
read_when:
  - Du ønsker baggrunds-/parallelarbejde via agenten
  - Du ændrer sessions_spawn eller politik for sub-agent-værktøjer
title: "Sub-agenter"
x-i18n:
  source_path: tools/subagents.md
  source_hash: 3c83eeed69a65dbb
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:53Z
---

# Sub-agenter

Sub-agenter er baggrundsagentkørsler, der startes fra en eksisterende agentkørsel. De kører i deres egen session (`agent:<agentId>:subagent:<uuid>`) og **annoncerer**, når de er færdige, deres resultat tilbage til anmoderens chatkanal.

## Slash-kommando

Brug `/subagents` til at inspicere eller styre sub-agentkørsler for den **aktuelle session**:

- `/subagents list`
- `/subagents stop <id|#|all>`
- `/subagents log <id|#> [limit] [tools]`
- `/subagents info <id|#>`
- `/subagents send <id|#> <message>`

`/subagents info` viser kørselsmetadata (status, tidsstempler, session-id, transkriptsti, oprydning).

Primære mål:

- Parallelisere “research / lang opgave / langsomt værktøj”-arbejde uden at blokere hovedkørslen.
- Holde sub-agenter isolerede som standard (sessionsadskillelse + valgfri sandboxing).
- Gøre værktøjsfladen svær at misbruge: sub-agenter får **ikke** sessionværktøjer som standard.
- Undgå indlejret fan-out: sub-agenter kan ikke starte sub-agenter.

Omkostningsnote: hver sub-agent har sin **egen** kontekst og tokenforbrug. For tunge eller gentagne
opgaver bør du sætte en billigere model for sub-agenter og beholde din hovedagent på en model med højere kvalitet.
Du kan konfigurere dette via `agents.defaults.subagents.model` eller pr. agent-override.

## Værktøj

Brug `sessions_spawn`:

- Starter en sub-agentkørsel (`deliver: false`, global bane: `subagent`)
- Kører derefter et announce-trin og poster announce-svaret til anmoderens chatkanal
- Standardmodel: arver fra kaldende agent, medmindre du sætter `agents.defaults.subagents.model` (eller pr. agent `agents.list[].subagents.model`); en eksplicit `sessions_spawn.model` vinder stadig.
- Standardtænkning: arver fra kaldende agent, medmindre du sætter `agents.defaults.subagents.thinking` (eller pr. agent `agents.list[].subagents.thinking`); en eksplicit `sessions_spawn.thinking` vinder stadig.

Værktøjsparametre:

- `task` (påkrævet)
- `label?` (valgfri)
- `agentId?` (valgfri; start under et andet agent-id, hvis tilladt)
- `model?` (valgfri; tilsidesætter sub-agentens model; ugyldige værdier springes over, og sub-agenten kører på standardmodellen med en advarsel i værktøjsresultatet)
- `thinking?` (valgfri; tilsidesætter tænkeniveau for sub-agentkørslen)
- `runTimeoutSeconds?` (standard `0`; når den er sat, afbrydes sub-agentkørslen efter N sekunder)
- `cleanup?` (`delete|keep`, standard `keep`)

Tilladelsesliste:

- `agents.list[].subagents.allowAgents`: liste over agent-id’er, der kan målrettes via `agentId` (`["*"]` for at tillade alle). Standard: kun anmoderagenten.

Discovery:

- Brug `agents_list` for at se, hvilke agent-id’er der i øjeblikket er tilladt for `sessions_spawn`.

Auto-arkivering:

- Sub-agentsessioner arkiveres automatisk efter `agents.defaults.subagents.archiveAfterMinutes` (standard: 60).
- Arkivering bruger `sessions.delete` og omdøber transkriptet til `*.deleted.<timestamp>` (samme mappe).
- `cleanup: "delete"` arkiverer straks efter announce (bevarer stadig transkriptet via omdøbning).
- Auto-arkivering er best-effort; ventende timere går tabt, hvis gatewayen genstarter.
- `runTimeoutSeconds` auto-arkiverer **ikke**; den stopper kun kørslen. Sessionen forbliver indtil auto-arkivering.

## Autentificering

Sub-agent-autentificering afgøres af **agent-id**, ikke af sessionstype:

- Sub-agentens sessionsnøgle er `agent:<agentId>:subagent:<uuid>`.
- Autentificeringslageret indlæses fra den agents `agentDir`.
- Hovedagentens auth-profiler flettes ind som **fallback**; agentprofiler tilsidesætter hovedprofiler ved konflikter.

Bemærk: sammenfletningen er additiv, så hovedprofiler er altid tilgængelige som fallback. Fuldt isoleret auth pr. agent understøttes endnu ikke.

## Announce

Sub-agenter rapporterer tilbage via et announce-trin:

- Announce-trinnet kører inde i sub-agentsessionen (ikke i anmodersessionen).
- Hvis sub-agenten svarer præcis `ANNOUNCE_SKIP`, postes der intet.
- Ellers postes announce-svaret til anmoderens chatkanal via et opfølgende `agent`-kald (`deliver=true`).
- Announce-svar bevarer tråd-/emnerouting, når det er tilgængeligt (Slack-tråde, Telegram-emner, Matrix-tråde).
- Announce-beskeder normaliseres til en stabil skabelon:
  - `Status:` afledt af kørselsudfaldet (`success`, `error`, `timeout` eller `unknown`).
  - `Result:` resumeindholdet fra announce-trinnet (eller `(not available)` hvis det mangler).
  - `Notes:` fejldetaljer og anden nyttig kontekst.
- `Status` udledes ikke fra modeloutput; det kommer fra runtime-udfaldssignaler.

Announce-payloads inkluderer en statistiklinje til sidst (selv når den er indpakket):

- Køretid (f.eks. `runtime 5m12s`)
- Tokenforbrug (input/output/i alt)
- Estimeret omkostning, når modelpriser er konfigureret (`models.providers.*.models[].cost`)
- `sessionKey`, `sessionId` og transkriptsti (så hovedagenten kan hente historik via `sessions_history` eller inspicere filen på disk)

## Værktøjspolitik (sub-agent-værktøjer)

Som standard får sub-agenter **alle værktøjer undtagen sessionværktøjer**:

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

Tilsidesæt via konfiguration:

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

## Samtidighed

Sub-agenter bruger en dedikeret in-process kø-bane:

- Bane-navn: `subagent`
- Samtidighed: `agents.defaults.subagents.maxConcurrent` (standard `8`)

## Stop

- Afsendelse af `/stop` i anmoderens chat afbryder anmodersessionen og stopper alle aktive sub-agentkørsler, der er startet fra den.

## Begrænsninger

- Sub-agent-announce er **best-effort**. Hvis gatewayen genstarter, går ventende “announce tilbage”-arbejde tabt.
- Sub-agenter deler stadig de samme gateway-procesressourcer; betragt `maxConcurrent` som en sikkerhedsventil.
- `sessions_spawn` er altid ikke-blokerende: den returnerer `{ status: "accepted", runId, childSessionKey }` med det samme.
- Sub-agentkontekst injicerer kun `AGENTS.md` + `TOOLS.md` (ingen `SOUL.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md` eller `BOOTSTRAP.md`).
