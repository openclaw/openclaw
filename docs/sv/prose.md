---
summary: "OpenProse: .prose-arbetsflöden, snedstreckskommandon och tillstånd i OpenClaw"
read_when:
  - Du vill köra eller skriva .prose-arbetsflöden
  - Du vill aktivera OpenProse-pluginet
  - Du behöver förstå lagring av tillstånd
title: "OpenProse"
---

# OpenProse

OpenProse är ett portabelt, markdown-first workflow-format för att orkestrera AI-sessioner. I OpenClaw levereras den som en plugin som installerar ett OpenProse färdighetspaket plus ett `/prose`-snedstreck kommando. Program lever i `.prose`-filer och kan skapa flera underagenter med explicit kontrollflöde.

Officiell webbplats: [https://www.prose.md](https://www.prose.md)

## Vad det kan göra

- Fleragentsforskning + syntes med explicit parallellism.
- Repeterbara, godkännandesäkra arbetsflöden (kodgranskning, incidenttriagering, innehållspipelines).
- Återanvändbara `.prose`-program som du kan köra över stödda agentruntimer.

## Installera + aktivera

Paketerade plugins är inaktiverade som standard. Aktivera OpenProse:

```bash
openclaw plugins enable open-prose
```

Starta om Gateway efter att ha aktiverat pluginet.

Dev/lokal utcheckning: `openclaw plugins install ./extensions/open-prose`

Relaterad dokumentation: [Plugins](/tools/plugin), [Plugin-manifest](/plugins/manifest), [Skills](/tools/skills).

## Snedstreckskommando

OpenProse registrerar `/prose` som ett användarvänligt skicklighetskommando. Det rutter till OpenProse VM instruktioner och använder OpenClaw verktyg under huvan.

Vanliga kommandon:

```
/prose help
/prose run <file.prose>
/prose run <handle/slug>
/prose run <https://example.com/file.prose>
/prose compile <file.prose>
/prose examples
/prose update
```

## Exempel: en enkel `.prose`-fil

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

## Filplatser

OpenProse behåller tillstånd under `.prose/` i din arbetsyta:

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

Persistenta agenter på användarnivå finns på:

```
~/.prose/agents/
```

## Tillståndslägen

OpenProse stöder flera tillståndsbackends:

- **filesystem** (standard): `.prose/runs/...`
- **in-context**: transient, för små program
- **sqlite** (experimentellt): kräver `sqlite3`-binären
- **postgres** (experimentellt): kräver `psql` och en anslutningssträng

Noteringar:

- sqlite/postgres är opt-in och experimentella.
- postgres-uppgifter flödar in i underagentloggar; använd en dedikerad DB med minsta möjliga privilegier.

## Fjärrprogram

`/prose run <handle/slug>` löser sig till `https://p.prose.md/<handle>/<slug>`.
Direkta URL:er hämtas som is. Detta använder verktyget `web_fetch` (eller `exec` för POST).

## OpenClaw runtime-mappning

OpenProse-program mappar till OpenClaw-primitiver:

| OpenProse-koncept            | OpenClaw-verktyg |
| ---------------------------- | ---------------- |
| Skapa session / Task-verktyg | `sessions_spawn` |
| Filläsning/-skrivning        | `read` / `write` |
| Webbhämtning                 | `web_fetch`      |

Om ditt verktyg tillåter blockering av dessa verktyg kommer OpenProse-program att misslyckas. Se [Färdigheter config](/tools/skills-config).

## Säkerhet + godkännanden

Behandla `.prose`-filer som kod. Granska innan du kör. Använd OpenClaw verktyg tillåten lista och portar godkännande för att kontrollera biverkningar.

För deterministiska, godkännandekontrollerade arbetsflöden, jämför med [Lobster](/tools/lobster).
