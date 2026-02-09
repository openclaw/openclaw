---
summary: "OpenProse: .prose-workflows, slash-kommandoer og tilstand i OpenClaw"
read_when:
  - Du vil køre eller skrive .prose-workflows
  - Du vil aktivere OpenProse-pluginet
  - Du har brug for at forstå tilstandslagring
title: "OpenProse"
---

# OpenProse

OpenProse er en bærbar, markdown-første workflow format til orchestrating AI sessioner. I OpenClaw det skibe som et plugin, der installerer en OpenProse færdighed pack plus en `/prose` skråstreg kommando. Programmer live i `.prose` filer og kan gyde flere sub-agenter med eksplicit kontrol flow.

Officiel side: [https://www.prose.md](https://www.prose.md)

## Hvad det kan

- Fleragent-research + syntese med eksplicit parallelisme.
- Gentagelige, godkendelsessikre workflows (kodegennemgang, hændelsestriage, indholdspipelines).
- Genanvendelige `.prose`-programmer, som du kan køre på tværs af understøttede agent-runtimes.

## Installér + aktivér

Medfølgende plugins er som standard deaktiveret. Aktiver OpenProse:

```bash
openclaw plugins enable open-prose
```

Genstart Gateway efter aktivering af pluginet.

Dev/lokal checkout: `openclaw plugins install ./extensions/open-prose`

Relaterede docs: [Plugins](/tools/plugin), [Plugin-manifest](/plugins/manifest), [Skills](/tools/skills).

## Slash-kommando

OpenProse registrerer `/prose` som en bruger-uigenkaldelig færdighedskill kommando. Den ruter til OpenProse VM instruktioner og bruger OpenClaw værktøjer under hætten.

Almindelige kommandoer:

```
/prose help
/prose run <file.prose>
/prose run <handle/slug>
/prose run <https://example.com/file.prose>
/prose compile <file.prose>
/prose examples
/prose update
```

## Eksempel: en simpel `.prose`-fil

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

## Filplaceringer

OpenProse gemmer tilstand under `.prose/` i dit workspace:

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

Vedvarende agenter på brugerniveau findes på:

```
~/.prose/agents/
```

## Tilstandstilstande

OpenProse understøtter flere tilstands-backends:

- **filesystem** (standard): `.prose/runs/...`
- **in-context**: flygtig, til små programmer
- **sqlite** (eksperimentel): kræver `sqlite3`-binæren
- **postgres** (eksperimentel): kræver `psql` og en forbindelsesstreng

Noter:

- sqlite/postgres er opt-in og eksperimentelle.
- postgres-legitimationsoplysninger flyder ind i underagent-logs; brug en dedikeret DB med mindst mulige rettigheder.

## Fjernprogrammer

`/prose run <handle/slug>` resolves to `https://p.prose.md/<handle>/<slug>`.
Direkte URL'er hentes som de er. Dette bruger værktøjet `web_fetch` (eller `exec` for POST).

## OpenClaw runtime-mapping

OpenProse-programmer mapper til OpenClaw-primitiver:

| OpenProse-koncept         | OpenClaw-værktøj |
| ------------------------- | ---------------- |
| Start session / Task tool | `sessions_spawn` |
| Fil-læsning/skrivning     | `read` / `write` |
| Web-hentning              | `web_fetch`      |

Hvis dit værktøj tillader blokering af disse værktøjer, vil OpenProse programmer mislykkes. Se [Skills config](/tools/skills-config).

## Sikkerhed + godkendelser

Behandl `.prose` filer som kode. Gennemgå før kørsel. Brug OpenClaw værktøj tillader lister og godkendelsesporte til at kontrollere bivirkninger.

For deterministiske workflows med godkendelsesporte kan du sammenligne med [Lobster](/tools/lobster).
