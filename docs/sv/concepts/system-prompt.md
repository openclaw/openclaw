---
summary: "Vad OpenClaws systemprompt innehåller och hur den sätts samman"
read_when:
  - Redigering av systempromptens text, verktygslista eller avsnitt för tid/hjärtslag
  - Ändring av beteende för bootstrap av arbetsyta eller injicering av Skills
title: "Systemprompt"
x-i18n:
  source_path: concepts/system-prompt.md
  source_hash: 1de1b529402a5f1b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:17:11Z
---

# Systemprompt

OpenClaw bygger en anpassad systemprompt för varje agentkörning. Prompten är **OpenClaw-ägd** och använder inte standardprompten från p-coding-agent.

Prompten sätts samman av OpenClaw och injiceras i varje agentkörning.

## Struktur

Prompten är avsiktligt kompakt och använder fasta avsnitt:

- **Tooling**: aktuell verktygslista + korta beskrivningar.
- **Safety**: kort påminnelse om skyddsräcken för att undvika maktsökande beteende eller kringgående av tillsyn.
- **Skills** (när tillgängliga): talar om för modellen hur den laddar skill-instruktioner vid behov.
- **OpenClaw Self-Update**: hur man kör `config.apply` och `update.run`.
- **Workspace**: arbetskatalog (`agents.defaults.workspace`).
- **Documentation**: lokal sökväg till OpenClaw-dokumentation (repo eller npm-paket) och när den ska läsas.
- **Workspace Files (injected)**: anger att bootstrap-filer ingår nedan.
- **Sandbox** (när aktiverad): anger sandboxad körmiljö, sandbox-sökvägar och om förhöjd exec är tillgänglig.
- **Current Date & Time**: användarlokal tid, tidszon och tidsformat.
- **Reply Tags**: valfri syntax för svarstaggar för leverantörer som stöds.
- **Heartbeats**: prompt för hjärtslag och ack-beteende.
- **Runtime**: värd, OS, node, modell, repo-rot (när upptäckt), tänkenivå (en rad).
- **Reasoning**: aktuell synlighetsnivå + ledtråd för /reasoning-växling.

Säkerhetsskyddsräcken i systemprompten är rådgivande. De vägleder modellens beteende men verkställer inte policy. Använd verktygspolicy, exec-godkännanden, sandboxing och kanal-tillåtelselistor för hård verkställighet; operatörer kan inaktivera dessa av design.

## Promptlägen

OpenClaw kan rendera mindre systemprompter för underagenter. Runtime sätter en
`promptMode` för varje körning (inte en användarvänd konfiguration):

- `full` (standard): inkluderar alla avsnitt ovan.
- `minimal`: används för underagenter; utelämnar **Skills**, **Memory Recall**, **OpenClaw
  Self-Update**, **Model Aliases**, **User Identity**, **Reply Tags**,
  **Messaging**, **Silent Replies** och **Heartbeats**. Tooling, **Safety**,
  Workspace, Sandbox, Current Date & Time (när känd), Runtime och injicerad
  kontext finns kvar.
- `none`: returnerar endast basidentitetsraden.

När `promptMode=minimal` märks extra injicerade prompter som **Subagent
Context** i stället för **Group Chat Context**.

## Injektion av workspace-bootstrap

Bootstrap-filer trimmas och läggs till under **Project Context** så att modellen ser identitets- och profilkontext utan att behöva explicita läsningar:

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md` (endast på helt nya arbetsytor)

Stora filer trunkeras med en markör. Maxstorlek per fil styrs av
`agents.defaults.bootstrapMaxChars` (standard: 20000). Saknade filer injicerar en
kort markör för saknad fil.

Interna hooks kan fånga upp detta steg via `agent:bootstrap` för att mutera eller ersätta
de injicerade bootstrap-filerna (till exempel genom att byta `SOUL.md` mot en alternativ persona).

För att inspektera hur mycket varje injicerad fil bidrar (rå vs injicerad, trunkering, plus overhead för verktygsscheman), använd `/context list` eller `/context detail`. Se [Context](/concepts/context).

## Tids­hantering

Systemprompten inkluderar ett dedikerat avsnitt **Current Date & Time** när
användarens tidszon är känd. För att hålla promptcachen stabil inkluderar den nu endast
**tidszonen** (ingen dynamisk klocka eller tidsformat).

Använd `session_status` när agenten behöver aktuell tid; statuskortet
innehåller en tidsstämpelrad.

Konfigurera med:

- `agents.defaults.userTimezone`
- `agents.defaults.timeFormat` (`auto` | `12` | `24`)

Se [Date & Time](/date-time) för fullständiga beteendedetaljer.

## Skills

När kvalificerade skills finns injicerar OpenClaw en kompakt **lista över tillgängliga skills**
(`formatSkillsForPrompt`) som inkluderar **fil­sökvägen** för varje skill. Prompten instruerar modellen att använda `read` för att ladda SKILL.md på den listade
platsen (arbetsyta, hanterad eller buntad). Om inga skills är kvalificerade utelämnas
avsnittet Skills.

```
<available_skills>
  <skill>
    <name>...</name>
    <description>...</description>
    <location>...</location>
  </skill>
</available_skills>
```

Detta håller basprompten liten samtidigt som riktad användning av skills möjliggörs.

## Dokumentation

När tillgänglig inkluderar systemprompten ett avsnitt **Documentation** som pekar på den
lokala OpenClaw-dokumentationskatalogen (antingen `docs/` i repo-arbetsytan eller den buntade npm-
paketdokumentationen) och noterar även den publika spegeln, källrepon, community Discord och
ClawHub ([https://clawhub.com](https://clawhub.com)) för discovery av skills. Prompten instruerar modellen att först konsultera lokala dokument
för OpenClaw-beteende, kommandon, konfiguration eller arkitektur, och att köra
`openclaw status` själv när det är möjligt (och bara fråga användaren när den saknar åtkomst).
