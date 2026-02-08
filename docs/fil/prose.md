---
summary: "OpenProse: mga .prose workflow, slash command, at state sa OpenClaw"
read_when:
  - Gusto mong magpatakbo o magsulat ng mga .prose workflow
  - Gusto mong i-enable ang OpenProse plugin
  - Kailangan mong maunawaan ang pag-iimbak ng state
title: "OpenProse"
x-i18n:
  source_path: prose.md
  source_hash: 53c161466d278e5f
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:48Z
---

# OpenProse

Ang OpenProse ay isang portable, markdown-first na format ng workflow para sa pag-o-orchestrate ng mga AI session. Sa OpenClaw, dumarating ito bilang isang plugin na nag-i-install ng OpenProse skill pack kasama ang isang `/prose` slash command. Ang mga programa ay nakatira sa mga `.prose` file at maaaring mag-spawn ng maraming sub-agent na may malinaw na control flow.

Opisyal na site: [https://www.prose.md](https://www.prose.md)

## Ano ang kaya nitong gawin

- Multi-agent na pananaliksik + synthesis na may malinaw na parallelism.
- Mga nauulit at approval-safe na workflow (code review, incident triage, content pipelines).
- Mga reusable na `.prose` program na maaari mong patakbuhin sa mga suportadong agent runtime.

## I-install + i-enable

Naka-disable bilang default ang mga bundled plugin. I-enable ang OpenProse:

```bash
openclaw plugins enable open-prose
```

I-restart ang Gateway pagkatapos i-enable ang plugin.

Dev/local checkout: `openclaw plugins install ./extensions/open-prose`

Kaugnay na docs: [Plugins](/tools/plugin), [Plugin manifest](/plugins/manifest), [Skills](/tools/skills).

## Slash command

Ipinaparehistro ng OpenProse ang `/prose` bilang isang user-invocable na skill command. Iri-route nito ang mga tagubilin papunta sa OpenProse VM at gumagamit ng mga OpenClaw tool sa likod ng eksena.

Mga karaniwang command:

```
/prose help
/prose run <file.prose>
/prose run <handle/slug>
/prose run <https://example.com/file.prose>
/prose compile <file.prose>
/prose examples
/prose update
```

## Halimbawa: isang simpleng `.prose` file

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

## Mga lokasyon ng file

Pinapanatili ng OpenProse ang state sa ilalim ng `.prose/` sa iyong workspace:

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

Ang mga user-level na persistent agent ay matatagpuan sa:

```
~/.prose/agents/
```

## Mga mode ng state

Sinusuportahan ng OpenProse ang maraming state backend:

- **filesystem** (default): `.prose/runs/...`
- **in-context**: pansamantala, para sa maliliit na programa
- **sqlite** (experimental): nangangailangan ng `sqlite3` binary
- **postgres** (experimental): nangangailangan ng `psql` at isang connection string

Mga tala:

- Ang sqlite/postgres ay opt-in at experimental.
- Dumadaloy ang postgres credentials papunta sa mga log ng subagent; gumamit ng dedikado at least-privileged na DB.

## Mga remote na programa

Ang `/prose run <handle/slug>` ay nireresolba sa `https://p.prose.md/<handle>/<slug>`.
Ang mga direktang URL ay kinukuha kung ano-ano (as-is). Ginagamit nito ang `web_fetch` tool (o `exec` para sa POST).

## OpenClaw runtime mapping

Ang mga OpenProse program ay mina-map sa mga OpenClaw primitive:

| OpenProse concept         | OpenClaw tool    |
| ------------------------- | ---------------- |
| Spawn session / Task tool | `sessions_spawn` |
| File read/write           | `read` / `write` |
| Web fetch                 | `web_fetch`      |

Kung bina-block ng iyong tool allowlist ang mga tool na ito, babagsak ang mga OpenProse program. Tingnan ang [Skills config](/tools/skills-config).

## Seguridad + mga pag-apruba

Ituring ang mga `.prose` file na parang code. Suriin bago patakbuhin. Gumamit ng mga OpenClaw tool allowlist at approval gate para kontrolin ang mga side effect.

Para sa deterministiko at approval-gated na mga workflow, ihambing sa [Lobster](/tools/lobster).
