---
summary: "Wat de OpenClaw-systeemprompt bevat en hoe deze wordt samengesteld"
read_when:
  - Bewerken van systeemprompttekst, toolslijst of tijd-/heartbeat-secties
  - Wijzigen van werkruimte-bootstrap of gedrag voor Skills-injectie
title: "Systeemprompt"
---

# Systeemprompt

OpenClaw bouwt voor elke agent-run een aangepaste systeemprompt. De prompt is **eigendom van OpenClaw** en gebruikt niet de standaardprompt van p-coding-agent.

De prompt wordt door OpenClaw samengesteld en in elke agent-run geïnjecteerd.

## Structuur

De prompt is bewust compact en gebruikt vaste secties:

- **Tooling**: huidige toolslijst + korte beschrijvingen.
- **Safety**: korte herinnering aan guardrails om machtszoekend gedrag of het omzeilen van toezicht te vermijden.
- **Skills** (indien beschikbaar): vertelt het model hoe Skill-instructies on demand te laden.
- **OpenClaw Self-Update**: hoe `config.apply` en `update.run` uit te voeren.
- **Workspace**: werkmap (`agents.defaults.workspace`).
- **Documentation**: lokaal pad naar OpenClaw-documentatie (repo of npm-pakket) en wanneer deze te lezen.
- **Workspace Files (injected)**: geeft aan dat bootstrapbestanden hieronder zijn opgenomen.
- **Sandbox** (indien ingeschakeld): geeft een gesandboxde runtime aan, sandboxpaden en of verhoogde exec beschikbaar is.
- **Current Date & Time**: lokale tijd van de gebruiker, tijdzone en tijdformaat.
- **Reply Tags**: optionele reply-tag-syntaxis voor ondersteunde providers.
- **Heartbeats**: heartbeat-prompt en ack-gedrag.
- **Runtime**: host, OS, node, model, repo-root (indien gedetecteerd), denkniveau (één regel).
- **Reasoning**: huidig zichtbaarheidsniveau + hint voor de /reasoning-toggle.

Safety-guardrails in de systeemprompt zijn adviserend. Ze sturen modelgedrag maar handhaven geen beleid. Gebruik toolbeleid, uitvoeringsgoedkeuringen, sandboxing en kanaal-allowlists voor harde handhaving; operators kunnen deze bewust uitschakelen.

## Promptmodi

OpenClaw kan kleinere systeemprompts renderen voor sub-agents. De runtime stelt per run een
`promptMode` in (geen gebruikersgerichte configuratie):

- `full` (standaard): bevat alle bovenstaande secties.
- `minimal`: gebruikt voor sub-agents; laat **Skills**, **Memory Recall**, **OpenClaw
  Self-Update**, **Model Aliases**, **User Identity**, **Reply Tags**,
  **Messaging**, **Silent Replies** en **Heartbeats** weg. Tooling, **Safety**,
  Workspace, Sandbox, Current Date & Time (indien bekend), Runtime en geïnjecteerde
  context blijven beschikbaar.
- `none`: retourneert alleen de basisidentiteitsregel.

Wanneer `promptMode=minimal`, worden extra geïnjecteerde prompts gelabeld als **Subagent
Context** in plaats van **Group Chat Context**.

## Workspace-bootstrapinjectie

Bootstrapbestanden worden ingekort en toegevoegd onder **Project Context**, zodat het model identiteit en profielcontext ziet zonder expliciete reads:

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md` (alleen bij gloednieuwe werkruimtes)

Grote bestanden worden afgekapt met een markering. De maximale grootte per bestand wordt bepaald door
`agents.defaults.bootstrapMaxChars` (standaard: 20000). Ontbrekende bestanden injecteren een
korte ontbrekend-bestand-markering.

Interne hooks kunnen deze stap onderscheppen via `agent:bootstrap` om de geïnjecteerde
bootstrapbestanden te muteren of te vervangen (bijvoorbeeld het wisselen van `SOUL.md` voor een alternatieve persona).

Om te inspecteren hoeveel elke geïnjecteerde file bijdraagt (ruw vs. geïnjecteerd, afkapping, plus tool-schema-overhead), gebruik `/context list` of `/context detail`. Zie [Context](/concepts/context).

## Tijdafhandeling

De systeemprompt bevat een speciale sectie **Current Date & Time** wanneer de
tijdzone van de gebruiker bekend is. Om de prompt cache-stabiel te houden, bevat deze nu alleen
de **tijdzone** (geen dynamische klok of tijdformaat).

Gebruik `session_status` wanneer de agent de huidige tijd nodig heeft; de statuskaart
bevat een tijdstempelregel.

Configureren met:

- `agents.defaults.userTimezone`
- `agents.defaults.timeFormat` (`auto` | `12` | `24`)

Zie [Date & Time](/date-time) voor volledige gedragsdetails.

## Skills

Wanneer er in aanmerking komende Skills bestaan, injecteert OpenClaw een compacte **lijst met beschikbare Skills**
(`formatSkillsForPrompt`) die voor elke Skill het **bestandspad** bevat. De
prompt instrueert het model om `read` te gebruiken om de SKILL.md te laden op de vermelde
locatie (werkruimte, beheerd of gebundeld). Als er geen Skills in aanmerking komen, wordt de
Skills-sectie weggelaten.

```
<available_skills>
  <skill>
    <name>...</name>
    <description>...</description>
    <location>...</location>
  </skill>
</available_skills>
```

Dit houdt de basisprompt klein en maakt toch gericht gebruik van Skills mogelijk.

## Documentatie

Wanneer beschikbaar bevat de systeemprompt een sectie **Documentation** die verwijst naar de
lokale OpenClaw-documentatiemap (ofwel `docs/` in de repo-werkruimte of de gebundelde npm-
pakketdocumentatie) en vermeldt ook de publieke mirror, bronrepo, community-Discord en
ClawHub ([https://clawhub.com](https://clawhub.com)) voor Skill-discovery. De prompt instrueert het model om eerst de lokale documentatie te raadplegen
voor OpenClaw-gedrag, opdrachten, configuratie of architectuur, en om indien mogelijk zelf
`openclaw status` uit te voeren (alleen de gebruiker te vragen wanneer het geen toegang heeft).
