---
summary: "OpenProse: .prose-Workflows, Slash-Befehle und Zustände in OpenClaw"
read_when:
  - Sie möchten .prose-Workflows ausführen oder schreiben
  - Sie möchten das OpenProse-Plugin aktivieren
  - Sie müssen die Zustandspeicherung verstehen
title: "OpenProse"
---

# OpenProse

OpenProse ist ein portables, Markdown-zentriertes Workflow-Format zur Orchestrierung von KI-Sitzungen. In OpenClaw wird es als Plugin ausgeliefert, das ein OpenProse-Skill-Pack sowie einen `/prose`-Slash-Befehl installiert. Programme liegen in `.prose`-Dateien und können mehrere Sub-Agenten mit expliziter Kontrollflusssteuerung starten.

Offizielle Website: [https://www.prose.md](https://www.prose.md)

## Was es kann

- Multi-Agenten-Recherche und -Synthese mit expliziter Parallelität.
- Wiederholbare, freigabesichere Workflows (Code-Review, Incident-Triage, Content-Pipelines).
- Wiederverwendbare `.prose`-Programme, die Sie über unterstützte Agent-Laufzeiten hinweg ausführen können.

## Installieren + aktivieren

Gebündelte Plugins sind standardmäßig deaktiviert. Aktivieren Sie OpenProse:

```bash
openclaw plugins enable open-prose
```

Starten Sie das Gateway nach der Aktivierung des Plugins neu.

Dev-/lokaler Checkout: `openclaw plugins install ./extensions/open-prose`

Zugehörige Dokumente: [Plugins](/tools/plugin), [Plugin-Manifest](/plugins/manifest), [Skills](/tools/skills).

## Slash-Befehl

OpenProse registriert `/prose` als vom Benutzer aufrufbaren Skill-Befehl. Er leitet an die OpenProse-VM-Instruktionen weiter und verwendet unter der Haube OpenClaw-Werkzeuge.

Gängige Befehle:

```
/prose help
/prose run <file.prose>
/prose run <handle/slug>
/prose run <https://example.com/file.prose>
/prose compile <file.prose>
/prose examples
/prose update
```

## Beispiel: eine einfache `.prose`-Datei

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

## Datei-Orte

OpenProse speichert den Zustand unter `.prose/` in Ihrem Workspace:

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

Persistente Agenten auf Benutzerebene befinden sich unter:

```
~/.prose/agents/
```

## Zustandsmodi

OpenProse unterstützt mehrere Zustands-Backends:

- **filesystem** (Standard): `.prose/runs/...`
- **in-context**: transient, für kleine Programme
- **sqlite** (experimentell): erfordert das `sqlite3`-Binary
- **postgres** (experimentell): erfordert `psql` und eine Verbindungszeichenfolge

Hinweise:

- sqlite/postgres sind optional und experimentell.
- Postgres-Zugangsdaten fließen in Subagenten-Logs; verwenden Sie eine dedizierte Datenbank mit minimalen Rechten.

## Remote-Programme

`/prose run <handle/slug>` wird zu `https://p.prose.md/<handle>/<slug>` aufgelöst.
Direkte URLs werden unverändert abgerufen. Dies verwendet das `web_fetch`-Werkzeug (oder `exec` für POST).

## OpenClaw-Runtime-Zuordnung

OpenProse-Programme werden auf OpenClaw-Primitiven abgebildet:

| OpenProse-Konzept               | OpenClaw-Werkzeug |
| ------------------------------- | ----------------- |
| Sitzung starten / Task-Werkzeug | `sessions_spawn`  |
| Datei lesen/schreiben           | `read` / `write`  |
| Web-Abruf                       | `web_fetch`       |

Wenn Ihre Tool-Allowlist diese Werkzeuge blockiert, schlagen OpenProse-Programme fehl. Siehe [Skills-Konfiguration](/tools/skills-config).

## Sicherheit + Freigaben

Behandeln Sie `.prose`-Dateien wie Code. Prüfen Sie sie vor der Ausführung. Verwenden Sie OpenClaw-Tool-Allowlists und Freigabeschranken, um Nebenwirkungen zu kontrollieren.

Für deterministische, freigabegesteuerte Workflows vergleichen Sie mit [Lobster](/tools/lobster).
