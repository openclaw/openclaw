---
summary: "Context: wat het model ziet, hoe die wordt opgebouwd en hoe je deze kunt inspecteren"
read_when:
  - Je wilt begrijpen wat “context” betekent in OpenClaw
  - Je bent aan het debuggen waarom het model iets “weet” (of is vergeten)
  - Je wilt context-overhead verminderen (/context, /status, /compact)
title: "Context"
---

# Context

“Context” is **alles wat OpenClaw naar het model stuurt voor een run**. Het wordt begrensd door het **contextvenster** van het model (tokenlimiet).

Mentaal model voor beginners:

- **Systeemprompt** (door OpenClaw opgebouwd): regels, tools, Skills-lijst, tijd/runtime en geïnjecteerde werkruimtebestanden.
- **Gespreksgeschiedenis**: jouw berichten + de berichten van de assistent voor deze sessie.
- **Tool-aanroepen/resultaten + bijlagen**: opdrachtuitvoer, bestandlezingen, afbeeldingen/audio, enz.

Context is _niet hetzelfde_ als “geheugen”: geheugen kan op schijf worden opgeslagen en later opnieuw worden geladen; context is wat zich binnen het huidige venster van het model bevindt.

## Snelle start (context inspecteren)

- `/status` → snelle weergave “hoe vol is mijn venster?” + sessie-instellingen.
- `/context list` → wat wordt geïnjecteerd + globale groottes (per bestand + totalen).
- `/context detail` → diepere uitsplitsing: per bestand, per-tool schema-groottes, per-skill itemgroottes en grootte van de systeemprompt.
- `/usage tokens` → voeg per-antwoord een gebruiksfooter toe aan normale antwoorden.
- `/compact` → vat oudere geschiedenis samen tot een compact item om vensterruimte vrij te maken.

Zie ook: [Slash-opdrachten](/tools/slash-commands), [Tokengebruik & kosten](/reference/token-use), [Compactie](/concepts/compaction).

## Voorbeelduitvoer

Waarden variëren per model, provider, toolbeleid en wat er in je werkruimte staat.

### `/context list`

```
🧠 Context breakdown
Workspace: <workspaceDir>
Bootstrap max/file: 20,000 chars
Sandbox: mode=non-main sandboxed=false
System prompt (run): 38,412 chars (~9,603 tok) (Project Context 23,901 chars (~5,976 tok))

Injected workspace files:
- AGENTS.md: OK | raw 1,742 chars (~436 tok) | injected 1,742 chars (~436 tok)
- SOUL.md: OK | raw 912 chars (~228 tok) | injected 912 chars (~228 tok)
- TOOLS.md: TRUNCATED | raw 54,210 chars (~13,553 tok) | injected 20,962 chars (~5,241 tok)
- IDENTITY.md: OK | raw 211 chars (~53 tok) | injected 211 chars (~53 tok)
- USER.md: OK | raw 388 chars (~97 tok) | injected 388 chars (~97 tok)
- HEARTBEAT.md: MISSING | raw 0 | injected 0
- BOOTSTRAP.md: OK | raw 0 chars (~0 tok) | injected 0 chars (~0 tok)

Skills list (system prompt text): 2,184 chars (~546 tok) (12 skills)
Tools: read, edit, write, exec, process, browser, message, sessions_send, …
Tool list (system prompt text): 1,032 chars (~258 tok)
Tool schemas (JSON): 31,988 chars (~7,997 tok) (counts toward context; not shown as text)
Tools: (same as above)

Session tokens (cached): 14,250 total / ctx=32,000
```

### `/context detail`

```
🧠 Context breakdown (detailed)
…
Top skills (prompt entry size):
- frontend-design: 412 chars (~103 tok)
- oracle: 401 chars (~101 tok)
… (+10 more skills)

Top tools (schema size):
- browser: 9,812 chars (~2,453 tok)
- exec: 6,240 chars (~1,560 tok)
… (+N more tools)
```

## Wat telt mee voor het contextvenster

Alles wat het model ontvangt telt mee, inclusief:

- Systeemprompt (alle secties).
- Gespreksgeschiedenis.
- Tool-aanroepen + toolresultaten.
- Bijlagen/transcripten (afbeeldingen/audio/bestanden).
- Compactiesamenvattingen en snoei-artefacten.
- Provider-“wrappers” of verborgen headers (niet zichtbaar, tellen wel mee).

## Hoe OpenClaw de systeemprompt opbouwt

De systeemprompt is **eigendom van OpenClaw** en wordt bij elke run opnieuw opgebouwd. Deze bevat:

- Toollijst + korte beschrijvingen.
- Skills-lijst (alleen metadata; zie hieronder).
- Locatie van de werkruimte.
- Tijd (UTC + geconverteerde gebruikerstijd indien geconfigureerd).
- Runtime-metadata (host/OS/model/denken).
- Geïnjecteerde werkruimte-bootstrapsbestanden onder **Project Context**.

Volledige uitsplitsing: [Systeemprompt](/concepts/system-prompt).

## Geïnjecteerde werkruimtebestanden (Project Context)

Standaard injecteert OpenClaw een vaste set werkruimtebestanden (indien aanwezig):

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md` (alleen bij eerste run)

Grote bestanden worden per bestand afgekapt met `agents.defaults.bootstrapMaxChars` (standaard `20000` tekens). `/context` toont **ruw vs. geïnjecteerd** formaat en of afkappen heeft plaatsgevonden.

## Skills: wat wordt geïnjecteerd vs. on-demand geladen

De systeemprompt bevat een compacte **skills-lijst** (naam + beschrijving + locatie). Deze lijst heeft reële overhead.

Skill-instructies worden standaard _niet_ opgenomen. Van het model wordt verwacht dat het `read` de `SKILL.md` van de skill **alleen wanneer nodig**.

## Tools: er zijn twee kosten

Tools beïnvloeden de context op twee manieren:

1. **Toollijst-tekst** in de systeemprompt (wat je ziet als “Tooling”).
2. **Tool-schema’s** (JSON). Deze worden naar het model gestuurd zodat het tools kan aanroepen. Ze tellen mee voor de context, ook al zie je ze niet als platte tekst.

`/context detail` splitst de grootste tool-schema’s uit zodat je kunt zien wat domineert.

## Opdrachten, directieven en “inline snelkoppelingen”

Slash-opdrachten worden door de Gateway afgehandeld. Er zijn een paar verschillende gedragingen:

- **Losstaande opdrachten**: een bericht dat alleen `/...` bevat, wordt als opdracht uitgevoerd.
- **Directieven**: `/think`, `/verbose`, `/reasoning`, `/elevated`, `/model`, `/queue` worden verwijderd voordat het model het bericht ziet.
  - Berichten die alleen uit directieven bestaan, laten sessie-instellingen voortbestaan.
  - Inline directieven in een normaal bericht werken als hints per bericht.
- **Inline snelkoppelingen** (alleen geautoriseerde afzenders): bepaalde `/...`-tokens binnen een normaal bericht kunnen direct worden uitgevoerd (voorbeeld: “hey /status”), en worden verwijderd voordat het model de resterende tekst ziet.

Details: [Slash-opdrachten](/tools/slash-commands).

## Sessies, compactie en snoeien (wat blijft bestaan)

Wat over berichten heen blijft bestaan, hangt af van het mechanisme:

- **Normale geschiedenis** blijft in het sessietranscript totdat deze volgens beleid wordt gecompacteerd/gesnoeid.
- **Compactie** slaat een samenvatting op in het transcript en behoudt recente berichten intact.
- **Snoeien** verwijdert oude toolresultaten uit de _in-memory_ prompt voor een run, maar herschrijft het transcript niet.

Documentatie: [Sessie](/concepts/session), [Compactie](/concepts/compaction), [Sessie-snoeien](/concepts/session-pruning).

## Wat `/context` daadwerkelijk rapporteert

`/context` verkiest het nieuwste **run-opgebouwde** systeemprompt-rapport wanneer beschikbaar:

- `System prompt (run)` = vastgelegd vanuit de laatste ingebedde (tool-geschikte) run en opgeslagen in de sessie-opslag.
- `System prompt (estimate)` = on-the-fly berekend wanneer er geen run-rapport bestaat (of bij uitvoering via een CLI-backend die het rapport niet genereert).

In beide gevallen rapporteert het groottes en belangrijkste bijdragers; het dumpt **niet** de volledige systeemprompt of tool-schema’s.
