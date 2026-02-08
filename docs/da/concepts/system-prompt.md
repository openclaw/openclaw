---
summary: "Hvad OpenClaw-systemprompten indeholder, og hvordan den sammensættes"
read_when:
  - Redigering af systemprompt-tekst, værktøjsliste eller tids-/heartbeat-sektioner
  - Ændring af workspace-bootstrap eller adfærd for Skills-injektion
title: "Systemprompt"
x-i18n:
  source_path: concepts/system-prompt.md
  source_hash: 1de1b529402a5f1b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:20Z
---

# Systemprompt

OpenClaw bygger en brugerdefineret systemprompt for hver agentkørsel. Prompten er **OpenClaw-ejet** og bruger ikke p-coding-agentens standardprompt.

Prompten sammensættes af OpenClaw og injiceres i hver agentkørsel.

## Struktur

Prompten er bevidst kompakt og bruger faste sektioner:

- **Tooling**: aktuel værktøjsliste + korte beskrivelser.
- **Safety**: kort påmindelse om værn for at undgå magtsøgende adfærd eller omgåelse af tilsyn.
- **Skills** (når tilgængelig): fortæller modellen, hvordan den indlæser skill-instruktioner efter behov.
- **OpenClaw Self-Update**: hvordan man kører `config.apply` og `update.run`.
- **Workspace**: arbejdsmappe (`agents.defaults.workspace`).
- **Documentation**: lokal sti til OpenClaw-dokumentation (repo eller npm-pakke) og hvornår den skal læses.
- **Workspace Files (injected)**: angiver, at bootstrap-filer er inkluderet nedenfor.
- **Sandbox** (når aktiveret): angiver sandboxet runtime, sandbox-stier, og om forhøjet exec er tilgængelig.
- **Current Date & Time**: brugerens lokale tid, tidszone og tidsformat.
- **Reply Tags**: valgfri svar-tag-syntaks for understøttede udbydere.
- **Heartbeats**: heartbeat-prompt og ack-adfærd.
- **Runtime**: vært, OS, node, model, repo-rod (når detekteret), tænkeniveau (én linje).
- **Reasoning**: aktuelt synlighedsniveau + /reasoning-toggle-hint.

Safety-værn i systemprompten er vejledende. De guider modellens adfærd, men håndhæver ikke politik. Brug værktøjspolitik, exec-godkendelser, sandboxing og kanal-tilladelseslister til hård håndhævelse; operatører kan deaktivere disse efter design.

## Prompt-tilstande

OpenClaw kan gengive mindre systemprompter til subagenter. Runtime sætter en
`promptMode` for hver kørsel (ikke en brugerrettet konfiguration):

- `full` (standard): inkluderer alle ovenstående sektioner.
- `minimal`: bruges til subagenter; udelader **Skills**, **Memory Recall**, **OpenClaw
  Self-Update**, **Model Aliases**, **User Identity**, **Reply Tags**,
  **Messaging**, **Silent Replies** og **Heartbeats**. Tooling, **Safety**,
  Workspace, Sandbox, Current Date & Time (når kendt), Runtime og injiceret
  kontekst forbliver tilgængelige.
- `none`: returnerer kun basis-identitetslinjen.

Når `promptMode=minimal`, mærkes ekstra injicerede prompts som **Subagent
Context** i stedet for **Group Chat Context**.

## Workspace-bootstrap-injektion

Bootstrap-filer trimmes og tilføjes under **Project Context**, så modellen ser identitets- og profilkontekst uden behov for eksplicit læsning:

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md` (kun på helt nye workspaces)

Store filer afkortes med en markør. Maks. størrelse pr. fil styres af
`agents.defaults.bootstrapMaxChars` (standard: 20000). Manglende filer injicerer en
kort markør for manglende fil.

Interne hooks kan afbryde dette trin via `agent:bootstrap` for at mutere eller erstatte
de injicerede bootstrap-filer (for eksempel ved at bytte `SOUL.md` ud med en alternativ persona).

For at inspicere, hvor meget hver injiceret fil bidrager (rå vs. injiceret, afkortning samt overhead fra værktøjsskema), brug `/context list` eller `/context detail`. Se [Context](/concepts/context).

## Tids-håndtering

Systemprompten inkluderer en dedikeret **Current Date & Time**-sektion, når
brugerens tidszone er kendt. For at holde prompt-cachen stabil inkluderer den nu kun
**tidszonen** (ingen dynamisk klokke eller tidsformat).

Brug `session_status`, når agenten har brug for den aktuelle tid; statuskortet
indeholder en tidsstempellinje.

Konfigurér med:

- `agents.defaults.userTimezone`
- `agents.defaults.timeFormat` (`auto` | `12` | `24`)

Se [Date & Time](/date-time) for fulde adfærdsdetaljer.

## Skills

Når der findes egnede Skills, injicerer OpenClaw en kompakt **liste over tilgængelige skills**
(`formatSkillsForPrompt`), som inkluderer **filstien** for hver skill. Prompten instruerer modellen i at bruge `read` til at indlæse SKILL.md på den angivne
placering (workspace, administreret eller bundlet). Hvis ingen Skills er egnede, udelades
Skills-sektionen.

```
<available_skills>
  <skill>
    <name>...</name>
    <description>...</description>
    <location>...</location>
  </skill>
</available_skills>
```

Dette holder basisprompten lille, samtidig med at målrettet brug af skills muliggøres.

## Dokumentation

Når tilgængelig, inkluderer systemprompten en **Documentation**-sektion, der peger på den
lokale OpenClaw-dokumentationsmappe (enten `docs/` i repo-workspace eller den bundtede npm-
pakkedokumentation) og bemærker også det offentlige spejl, kilde-repoet, community Discord og
ClawHub ([https://clawhub.com](https://clawhub.com)) til discovery af skills. Prompten instruerer modellen i først at konsultere lokale dokumenter
for OpenClaw-adfærd, kommandoer, konfiguration eller arkitektur, og selv at køre
`openclaw status` når det er muligt (kun at spørge brugeren, når den mangler adgang).
