---
summary: "OpenProse: .prose-workflows, slash-commando's en status in OpenClaw"
read_when:
  - Je wilt .prose-workflows uitvoeren of schrijven
  - Je wilt de OpenProse-plugin inschakelen
  - Je moet opslag van status begrijpen
title: "OpenProse"
---

# OpenProse

OpenProse is een draagbaar, markdown-first workflowformaat voor het orkestreren van AI-sessies. In OpenClaw wordt het geleverd als een plugin die een OpenProse skillpack installeert plus een `/prose` slash-commando. Programma's leven in `.prose`-bestanden en kunnen meerdere sub-agents starten met expliciete controlestroom.

Officiële site: [https://www.prose.md](https://www.prose.md)

## Wat het kan doen

- Multi-agent onderzoek + synthese met expliciete paralleliteit.
- Herhaalbare, goedkeuringsveilige workflows (code review, incidenttriage, contentpijplijnen).
- Herbruikbare `.prose`-programma's die je kunt uitvoeren op ondersteunde agent-runtimes.

## Installeren + inschakelen

Gebundelde plugins zijn standaard uitgeschakeld. Schakel OpenProse in:

```bash
openclaw plugins enable open-prose
```

Herstart de Gateway na het inschakelen van de plugin.

Dev/lokale checkout: `openclaw plugins install ./extensions/open-prose`

Gerelateerde documentatie: [Plugins](/tools/plugin), [Pluginmanifest](/plugins/manifest), [Skills](/tools/skills).

## Slash-commando

OpenProse registreert `/prose` als een door de gebruiker aanroepbaar skill-commando. Het routeert naar de OpenProse-VM-instructies en gebruikt OpenClaw-tools onder de motorkap.

Veelgebruikte opdrachten:

```
/prose help
/prose run <file.prose>
/prose run <handle/slug>
/prose run <https://example.com/file.prose>
/prose compile <file.prose>
/prose examples
/prose update
```

## Voorbeeld: een eenvoudig `.prose`-bestand

```prose
# Research + synthesis with two agents running in parallel.

input topic: "What should we research?"

agent researcher:
  model: sonnet
  prompt: "You research thoroughly and cite sources."

agent writer:
  model: opus
  prompt: "You write a concise summary."

parallel:
  findings = session: researcher
    prompt: "Research {topic}."
  draft = session: writer
    prompt: "Summarize {topic}."

session "Merge the findings + draft into a final answer."
context: { findings, draft }
```

## Bestandslocaties

OpenProse bewaart status onder `.prose/` in je werkruimte:

```
.prose/
├── .env
├── runs/
│   └── {YYYYMMDD}-{HHMMSS}-{random}/
│       ├── program.prose
│       ├── state.md
│       ├── bindings/
│       └── agents/
└── agents/
```

Persistente agents op gebruikersniveau bevinden zich op:

```
~/.prose/agents/
```

## Statusmodi

OpenProse ondersteunt meerdere status-backends:

- **filesystem** (standaard): `.prose/runs/...`
- **in-context**: tijdelijk, voor kleine programma's
- **sqlite** (experimenteel): vereist `sqlite3`-binary
- **postgres** (experimenteel): vereist `psql` en een verbindingsstring

Notities:

- sqlite/postgres zijn opt-in en experimenteel.
- postgres-referenties stromen door naar subagent-logs; gebruik een toegewijde DB met minimale rechten.

## Programma's op afstand

`/prose run <handle/slug>` wordt opgelost naar `https://p.prose.md/<handle>/<slug>`.
Directe URL's worden ongewijzigd opgehaald. Dit gebruikt de `web_fetch`-tool (of `exec` voor POST).

## OpenClaw runtime-mapping

OpenProse-programma's mappen naar OpenClaw-primitieven:

| OpenProse-concept          | OpenClaw-tool    |
| -------------------------- | ---------------- |
| Sessie starten / Task-tool | `sessions_spawn` |
| Bestand lezen/schrijven    | `read` / `write` |
| Web ophalen                | `web_fetch`      |

Als je tool-toegestane lijst deze tools blokkeert, zullen OpenProse-programma's falen. Zie [Skills-config](/tools/skills-config).

## Beveiliging + goedkeuringen

Behandel `.prose`-bestanden als code. Beoordeel ze vóór uitvoering. Gebruik OpenClaw tool-toegestane lijsten en goedkeuringspoorten om neveneffecten te beheersen.

Voor deterministische, door goedkeuring afgeschermde workflows, vergelijk met [Lobster](/tools/lobster).
