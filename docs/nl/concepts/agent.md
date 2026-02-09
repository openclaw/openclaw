---
summary: "Agent-runtime (embedded pi-mono), werkruimtecontract en sessie-bootstrap"
read_when:
  - Wijzigen van agent-runtime, werkruimte-bootstrap of sessiegedrag
title: "Agent-runtime"
---

# Agent-runtime 🤖

OpenClaw draait één enkele embedded agent-runtime die is afgeleid van **pi-mono**.

## Werkruimte (vereist)

OpenClaw gebruikt één agent-werkruimtemap (`agents.defaults.workspace`) als de **enige** werkdirectory (`cwd`) van de agent voor tools en context.

Aanbevolen: gebruik `openclaw setup` om `~/.openclaw/openclaw.json` aan te maken als deze ontbreekt en initialiseer de werkruimtebestanden.

Volledige werkruimte-indeling + back-uphandleiding: [Agent workspace](/concepts/agent-workspace)

Als `agents.defaults.sandbox` is ingeschakeld, kunnen niet-hoofdsessies dit overschrijven met
per-sessie werkruimtes onder `agents.defaults.sandbox.workspaceRoot` (zie
[Gateway configuration](/gateway/configuration)).

## Bootstrapbestanden (geïnjecteerd)

Binnen `agents.defaults.workspace` verwacht OpenClaw deze door de gebruiker te bewerken bestanden:

- `AGENTS.md` — bedieningsinstructies + “geheugen”
- `SOUL.md` — persona, grenzen, toon
- `TOOLS.md` — door de gebruiker onderhouden toolnotities (bijv. `imsg`, `sag`, conventies)
- `BOOTSTRAP.md` — eenmalig first-run-ritueel (verwijderd na voltooiing)
- `IDENTITY.md` — agentnaam/vibe/emoji
- `USER.md` — gebruikersprofiel + voorkeursaanspreekvorm

Bij de eerste beurt van een nieuwe sessie injecteert OpenClaw de inhoud van deze bestanden rechtstreeks in de agentcontext.

Lege bestanden worden overgeslagen. Grote bestanden worden ingekort en afgekapt met een markering zodat prompts compact blijven (lees het bestand voor de volledige inhoud).

Als een bestand ontbreekt, injecteert OpenClaw één regel met een “missing file”-markering (en `openclaw setup` maakt een veilig standaardtemplate aan).

`BOOTSTRAP.md` wordt alleen aangemaakt voor een **gloednieuwe werkruimte** (geen andere bootstrapbestanden aanwezig). Als je het na voltooiing van het ritueel verwijdert, zou het bij latere herstarts niet opnieuw moeten worden aangemaakt.

Om het aanmaken van bootstrapbestanden volledig uit te schakelen (voor vooraf gevulde werkruimtes), stel in:

```json5
{ agent: { skipBootstrap: true } }
```

## Ingebouwde tools

Kern-tools (lezen/uitvoeren/bewerken/schrijven en gerelateerde systeemtools) zijn altijd beschikbaar,
onderhevig aan toolbeleid. `apply_patch` is optioneel en afgeschermd door
`tools.exec.applyPatch`. `TOOLS.md` bepaalt **niet** welke tools bestaan; het is
richtlijn voor hoe _jij_ ze wilt gebruiken.

## Skills

OpenClaw laadt Skills uit drie locaties (werkruimte wint bij naamconflict):

- Gebundeld (meegeleverd met de installatie)
- Beheerd/lokaal: `~/.openclaw/skills`
- Werkruimte: `<workspace>/skills`

Skills kunnen worden afgeschermd via config/env (zie `skills` in [Gateway configuration](/gateway/configuration)).

## pi-mono-integratie

OpenClaw hergebruikt onderdelen van de pi-mono-codebase (modellen/tools), maar **sessiebeheer, discovery en tool-wiring zijn eigendom van OpenClaw**.

- Geen pi-coding agent-runtime.
- Er worden geen `~/.pi/agent`- of `<workspace>/.pi`-instellingen geraadpleegd.

## Sessies

Sessietranscripten worden opgeslagen als JSONL op:

- `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl`

De sessie-ID is stabiel en wordt door OpenClaw gekozen.
Legacy Pi/Tau-sessiemappen worden **niet** gelezen.

## Sturen tijdens streamen

Wanneer de wachtrijmodus `steer` is, worden inkomende berichten in de huidige run geïnjecteerd.
De wachtrij wordt **na elke toolcall** gecontroleerd; als er een bericht in de wachtrij staat,
worden resterende toolcalls van het huidige assistant-bericht overgeslagen (fouttoolresultaten met "Skipped due to queued user message."), waarna het bericht van de gebruiker uit de wachtrij wordt geïnjecteerd vóór de volgende assistant-respons.

Wanneer de wachtrijmodus `followup` of `collect` is, worden inkomende berichten vastgehouden totdat de
huidige beurt eindigt; daarna start een nieuwe agentbeurt met de payloads uit de wachtrij. Zie
[Queue](/concepts/queue) voor modus- en debounce/cap-gedrag.

Blokstreaming verzendt voltooide assistant-blokken zodra ze klaar zijn; dit staat
**standaard uit** (`agents.defaults.blockStreamingDefault: "off"`).
Stem de grens af via `agents.defaults.blockStreamingBreak` (`text_end` vs `message_end`; standaard text_end).
Beheer zachte blokchunking met `agents.defaults.blockStreamingChunk` (standaard
800–1200 tekens; geeft de voorkeur aan alinea-einden, daarna nieuwe regels; zinnen als laatste).
Voeg gestreamde chunks samen met `agents.defaults.blockStreamingCoalesce` om
single-line spam te verminderen (op inactiviteit gebaseerde samenvoeging vóór verzending). Niet-Telegram-kanalen vereisen
expliciete `*.blockStreaming: true` om blokantwoorden in te schakelen.
Uitgebreide tool-samenvattingen worden uitgezonden bij toolstart (geen debounce); Control UI
streamt tooluitvoer via agent-events wanneer beschikbaar.
Meer details: [Streaming + chunking](/concepts/streaming).

## Modelrefs

Modelrefs in config (bijvoorbeeld `agents.defaults.model` en `agents.defaults.models`) worden geparseerd door te splitsen op de **eerste** `/`.

- Gebruik `provider/model` bij het configureren van modellen.
- Als de model-ID zelf `/` bevat (OpenRouter-stijl), neem dan de providerprefix op (voorbeeld: `openrouter/moonshotai/kimi-k2`).
- Als je de provider weglaat, behandelt OpenClaw de invoer als een alias of als een model voor de **standaardprovider** (werkt alleen wanneer er geen `/` in de model-ID staat).

## Configuratie (minimaal)

Stel minimaal in:

- `agents.defaults.workspace`
- `channels.whatsapp.allowFrom` (sterk aanbevolen)

---

_Volgende: [Group Chats](/channels/group-messages)_ 🦞
