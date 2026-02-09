---
summary: "Sub-agenter: opstart af isolerede agentkørsler, der annoncerer resultater tilbage til anmoderens chat"
read_when:
  - Du ønsker baggrunds-/parallelarbejde via agenten
  - Du ændrer sessions_spawn eller politik for sub-agent-værktøjer
title: "Sub-agenter"
---

# Sub-agenter

Subagenter er baggrundsagentur kører opfostrede fra en eksisterende agent kørsel. De kører i deres egen session (`agent:<agentId>:subagent:<uuid>`) og, når færdig, \*\*annoncere \*\* deres resultat tilbage til anmoderen chat kanal.

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

Anskaffelsesbemærkning: Hver underagent har sin \*\* egen\*\* kontekst og token brug. For tunge eller gentagne
opgaver, indstille en billigere model for sub-agenter og holde din vigtigste agent på en højere kvalitet model.
Du kan konfigurere dette via `agents.defaults.subagents.model` eller per-agent overrides.

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

- `agents.list[].subagents.allowAgents`: liste over agenter ids, der kan målrettes via `agentId` (`["*"]` for at tillade alle). Standard: kun anmoderen.

Discovery:

- Brug `agents_list` for at se, hvilke agent-id’er der i øjeblikket er tilladt for `sessions_spawn`.

Auto-arkivering:

- Sub-agentsessioner arkiveres automatisk efter `agents.defaults.subagents.archiveAfterMinutes` (standard: 60).
- Arkiv bruger `sessions.delete` og omdøber udskriften til `*.deleted.<timestamp>` (samme mappe).
- `cleanup: "delete"` arkiverer straks efter announce (bevarer stadig transkriptet via omdøbning).
- Auto-arkivering er best-effort; ventende timere går tabt, hvis gatewayen genstarter.
- `runTimeoutSeconds` gør **ikke** auto-arkiv; det stopper kun kørslen. Sessionen forbliver indtil auto-arkivering.

## Autentificering

Sub-agent-autentificering afgøres af **agent-id**, ikke af sessionstype:

- Sub-agentens sessionsnøgle er `agent:<agentId>:subagent:<uuid>`.
- Autentificeringslageret indlæses fra den agents `agentDir`.
- Hovedagentens auth-profiler flettes ind som **fallback**; agentprofiler tilsidesætter hovedprofiler ved konflikter.

Bemærk: Sammenlægningen er additiv, så hovedprofiler er altid tilgængelige som tilbagefald. Fuldt isoleret auth per agent understøttes ikke endnu.

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

- Runtime (fx, `runtime 5m12s`)
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

- Underagent annoncere er **bedst indsats**. Hvis gateway genstarter, indtil “annoncere tilbage” arbejde er tabt.
- Sub-agenter deler stadig de samme gateway-procesressourcer; betragt `maxConcurrent` som en sikkerhedsventil.
- `sessions_spawn` er altid ikke-blokerende: den returnerer `{ status: "accepted", runId, childSessionKey }` med det samme.
- Sub-agentkontekst injicerer kun `AGENTS.md` + `TOOLS.md` (ingen `SOUL.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md` eller `BOOTSTRAP.md`).
