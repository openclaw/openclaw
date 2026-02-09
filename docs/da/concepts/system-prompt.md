---
summary: "Hvad OpenClaw-systemprompten indeholder, og hvordan den sammensættes"
read_when:
  - Redigering af systemprompt-tekst, værktøjsliste eller tids-/heartbeat-sektioner
  - Ændring af workspace-bootstrap eller adfærd for Skills-injektion
title: "Systemprompt"
---

# Systemprompt

OpenClaw opbygger en brugerdefineret systemprompt for hver agent kører. Opfordringen er **OpenClaw-owned** og bruger ikke p-coding-agent standardprompten.

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

Sikkerhed guardrails i systemet prompt er rådgivende. De styrer model adfærd, men ikke håndhæve politik. Brug værktøjspolitik, exec godkendelser, sandboxing, og kanal tillader lister for hård håndhævelse; operatører kan deaktivere disse ved design.

## Prompt-tilstande

OpenClaw kan gøre mindre system prompter for underagenter. Runtime sætter en
`promptMode` for hvert løb (ikke en brugervendende config):

- `full` (standard): inkluderer alle ovenstående sektioner.
- `minimal`: bruges til underagenter; udelader **Færdigheder**, **Hukommelsestilbagekaldelse**, **OpenClaw
  Selvopdatering**, **Model Aliases**, **Bruger Identitet**, **Svar Tags**,
  **Besked**, **Tavse gentagelser**, og **Heartbeats**. Værktøj, **Safety**,
  Workspace, Sandbox, aktuelle dato og tid (når det vide), Runtime, og injiceret
  kontekst forbliver tilgængelig.
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

Store filer afkortes med en markør. Den maksimale per fil størrelse styres af
`agents.defaults.bootstrapMaxChars` (standard: 20000). Manglende filer injicerer en
kort mangler filmarkør.

Interne hooks kan afbryde dette trin via `agent:bootstrap` for at mutere eller erstatte
de injicerede bootstrap-filer (for eksempel ved at bytte `SOUL.md` ud med en alternativ persona).

For at inspicere hvor meget hver enkelt fil bidrager (rå vs injiceret, trunkering, plus tool schema over head), brug `/context list` eller `/context detail`. Se [Context](/concepts/context).

## Tids-håndtering

Systemprompten inkluderer en dedikeret **Nuværende dato og tid** sektion når
brugertidszone er kendt. For at holde den prompte cache-stabil, omfatter den nu kun
\*\*tidszonen \*\* (intet dynamisk ur eller tidsformat).

Brug `session_status`, når agenten har brug for den aktuelle tid; statuskortet
indeholder en tidsstempellinje.

Konfigurér med:

- `agents.defaults.userTimezone`
- `agents.defaults.timeFormat` (`auto` | `12` | `24`)

Se [Date & Time](/date-time) for fulde adfærdsdetaljer.

## Skills

Når der findes kvalificerede færdigheder, tilfører OpenClaw en kompakt **tilgængelig færdighedsliste**
(`formatSkillsForPrompt`), der omfatter **filstien** for hver færdighed.
-prompten instruerer modellen i at bruge `read` til at indlæse SKILL.md på det angivne
-sted (arbejdsområde, håndteres eller bundtet). Hvis ingen færdigheder er kvalificeret, udelades sektionen
Færdigheder.

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

Hvis tilgængelig, systemprompten indeholder en \*\* Dokumentation\*\* sektion, der peger på den
lokale OpenClaw docs mappe (enten `docs/` i repo arbejdsområdet eller den medfølgende npm
pakkedokument) og også noterer det offentlige filspejl, source repo, community Discord, og
ClawHub ([https://clawhub.com](https://clawhub. om)) for færdigheder opdagelse. Opfordringen instruerer modellen til at konsultere lokale docs første
for OpenClaw adfærd, kommandoer, konfiguration, eller arkitektur, og at køre
'openclaw status' selv, når det er muligt (spørger kun brugeren når det mangler adgang).
