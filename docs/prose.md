---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "OpenProse: .prose workflows, slash commands, and state in OpenClaw"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to run or write .prose workflows（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to enable the OpenProse plugin（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need to understand state storage（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "OpenProse"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# OpenProse（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenProse is a portable, markdown-first workflow format for orchestrating AI sessions. In OpenClaw it ships as a plugin that installs an OpenProse skill pack plus a `/prose` slash command. Programs live in `.prose` files and can spawn multiple sub-agents with explicit control flow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Official site: [https://www.prose.md](https://www.prose.md)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What it can do（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Multi-agent research + synthesis with explicit parallelism.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Repeatable approval-safe workflows (code review, incident triage, content pipelines).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Reusable `.prose` programs you can run across supported agent runtimes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Install + enable（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Bundled plugins are disabled by default. Enable OpenProse:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins enable open-prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Restart the Gateway after enabling the plugin.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Dev/local checkout: `openclaw plugins install ./extensions/open-prose`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Related docs: [Plugins](/tools/plugin), [Plugin manifest](/plugins/manifest), [Skills](/tools/skills).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Slash command（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenProse registers `/prose` as a user-invocable skill command. It routes to the OpenProse VM instructions and uses OpenClaw tools under the hood.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common commands:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/prose help（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/prose run <file.prose>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/prose run <handle/slug>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/prose run <https://example.com/file.prose>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/prose compile <file.prose>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/prose examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/prose update（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Example: a simple `.prose` file（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Research + synthesis with two agents running in parallel.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
input topic: "What should we research?"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent researcher:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: sonnet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "You research thoroughly and cite sources."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent writer:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: opus（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "You write a concise summary."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  findings = session: researcher（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    prompt: "Research {topic}."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  draft = session: writer（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    prompt: "Summarize {topic}."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Merge the findings + draft into a final answer."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
context: { findings, draft }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## File locations（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenProse keeps state under `.prose/` in your workspace:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
.prose/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── .env（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── runs/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   └── {YYYYMMDD}-{HHMMSS}-{random}/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│       ├── program.prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│       ├── state.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│       ├── bindings/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│       └── agents/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
└── agents/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
User-level persistent agents live at:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
~/.prose/agents/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## State modes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenProse supports multiple state backends:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **filesystem** (default): `.prose/runs/...`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **in-context**: transient, for small programs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **sqlite** (experimental): requires `sqlite3` binary（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **postgres** (experimental): requires `psql` and a connection string（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- sqlite/postgres are opt-in and experimental.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- postgres credentials flow into subagent logs; use a dedicated, least-privileged DB.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Remote programs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`/prose run <handle/slug>` resolves to `https://p.prose.md/<handle>/<slug>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Direct URLs are fetched as-is. This uses the `web_fetch` tool (or `exec` for POST).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## OpenClaw runtime mapping（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenProse programs map to OpenClaw primitives:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| OpenProse concept         | OpenClaw tool    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------------- | ---------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Spawn session / Task tool | `sessions_spawn` |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| File read/write           | `read` / `write` |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Web fetch                 | `web_fetch`      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If your tool allowlist blocks these tools, OpenProse programs will fail. See [Skills config](/tools/skills-config).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Security + approvals（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Treat `.prose` files like code. Review before running. Use OpenClaw tool allowlists and approval gates to control side effects.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For deterministic, approval-gated workflows, compare with [Lobster](/tools/lobster).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
