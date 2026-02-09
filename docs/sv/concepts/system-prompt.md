---
summary: "Vad OpenClaws systemprompt innehåller och hur den sätts samman"
read_when:
  - Redigering av systempromptens text, verktygslista eller avsnitt för tid/hjärtslag
  - Ändring av beteende för bootstrap av arbetsyta eller injicering av Skills
title: "Systemprompt"
---

# Systemprompt

OpenClaw bygger en egen systemprompt för varje agentkörning. prompten är **OpenClaw-owned** och använder inte standardprompten för p-kodning agent.

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

Skyddsräcken i systemet är rådgivande. De styr modellbeteendet men upprätthåller inte politiken. Använd verktygspolicy, exec godkännanden, sandlåda och kanal tillåten listor för hård verkställighet; operatörer kan inaktivera dessa genom design.

## Promptlägen

OpenClaw kan göra mindre systemförfrågningar för underagenter. Runtime sätter en
`promptMode` för varje körning (inte en användarvänd konfiguration):

- `full` (standard): inkluderar alla avsnitt ovan.
- `minimal`: används för underagenter; utelämnar **färdigheter**, **minne**, **OpenClaw
  Självuppdatering**, **Modellalias**, **Användar-identitet**, **Svara etiketter**,
  **Meddelande**, **Tysta svar**och **hjärtslag**. Verktyg, **Säkerhet**,
  arbetsyta, Sandlåda, aktuellt datum och tid (när det är känt), Körtid och injicerade
  -sammanhang förblir tillgängligt.
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

Stora filer trunkeras med en markör. Den maximala storleken per fil kontrolleras av
`agents.defaults.bootstrapMaxChars` (standard: 20000). Saknade filer injicerar en
kort saknad filmarkör.

Interna hooks kan fånga upp detta steg via `agent:bootstrap` för att mutera eller ersätta
de injicerade bootstrap-filerna (till exempel genom att byta `SOUL.md` mot en alternativ persona).

För att inspektera hur mycket varje injicerad fil bidrar (rå vs injicerad, trunkering, plus verktygsschema overhead), använd `/context list` eller `/context detail`. Se [Context](/concepts/context).

## Tids­hantering

Systemprompten innehåller en dedikerad **Datum och tid** sektion när
användarens tidszon är känd. För att behålla prompten cache-stable innehåller den nu endast
**tidszonen** (ingen dynamisk klocka eller tidsformat).

Använd `session_status` när agenten behöver aktuell tid; statuskortet
innehåller en tidsstämpelrad.

Konfigurera med:

- `agents.defaults.userTimezone`
- `agents.defaults.timeFormat` (`auto` | `12` | `24`)

Se [Date & Time](/date-time) för fullständiga beteendedetaljer.

## Skills

När kvalificerade färdigheter finns, injicerar OpenClaw en kompakt **tillgänglig lista över färdigheter**
(`formatSkillsForPrompt`) som innehåller **filsökväg** för varje färdighet.
-prompten instruerar modellen att använda `read` för att ladda SKILL.md på den listade
-platsen (arbetsyta, hanteras eller paketeras). Om inga färdigheter är berättigade utelämnas sektionen
Färdigheter.

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

When available, the system prompt includes a **Documentation** section that points to the
local OpenClaw docs directory (either `docs/` in the repo workspace or the bundled npm
package docs) and also notes the public mirror, source repo, community Discord, and
ClawHub ([https://clawhub.com](https://clawhub.com)) for skills discovery. prompten instruerar modellen att konsultera lokala dokument först
för OpenClaw beteende, kommandon, konfiguration, eller arkitektur, och att köra
`openclaw status` själv när det är möjligt (frågar användaren endast när den saknar åtkomst).
