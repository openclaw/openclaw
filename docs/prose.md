---
summary: "OpenProse: .prose workflows, slash commands, state, and telemetry in Clawdbot"
read_when:
  - You want to run or write .prose workflows
  - You want to enable the OpenProse plugin
  - You need to understand telemetry or state storage
---
# OpenProse

OpenProse is a portable, markdown-first workflow format for orchestrating AI sessions. In Clawdbot it ships as a plugin that installs an OpenProse skill pack plus a `/prose` slash command. Programs live in `.prose` files and can spawn multiple sub-agents with explicit control flow.

## Install + enable

Bundled plugins are disabled by default. Enable OpenProse:

```bash
clawdbot plugins enable open-prose
```

If you're using a local checkout instead of bundled:

```bash
clawdbot plugins install ./extensions/open-prose
```

Restart the Gateway after enabling or installing the plugin.

Related docs: [Plugins](/plugin), [Plugin manifest](/plugins/manifest), [Skills](/tools/skills).

## Slash command

OpenProse registers `/prose` as a user-invocable skill command. It routes to the OpenProse VM instructions and uses Clawdbot tools under the hood.

Common commands:

```
/prose help
/prose run <file.prose>
/prose run <handle/slug>
/prose run <https://example.com/file.prose>
/prose compile <file.prose>
/prose examples
/prose update
```

## File locations

OpenProse keeps state under `.prose/` in your workspace:

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

User-level persistent agents live at:

```
~/.prose/agents/
```

## State modes

OpenProse supports multiple state backends:

- **filesystem** (default): `.prose/runs/...`
- **in-context**: transient, for small programs
- **sqlite** (experimental): requires `sqlite3` binary
- **postgres** (experimental): requires `psql` and a connection string

Notes:
- sqlite/postgres are opt-in and experimental.
- postgres credentials flow into subagent logs; use a dedicated, least-privileged DB.

## Remote programs

`/prose run <handle/slug>` resolves to `https://p.prose.md/<handle>/<slug>`.
Direct URLs are fetched as-is. This uses the `web_fetch` tool (or `exec` for POST).

## Clawdbot runtime mapping

OpenProse programs map to Clawdbot primitives:

| OpenProse concept | Clawdbot tool |
| --- | --- |
| Spawn session / Task tool | `sessions_spawn` |
| File read/write | `read` / `write` |
| Web fetch | `web_fetch` |

If your tool allowlist blocks these tools, OpenProse programs will fail. See [Skills config](/tools/skills-config).

## Telemetry

OpenProse telemetry is **enabled by default** and stored in `.prose/.env`:

```
OPENPROSE_TELEMETRY=enabled
USER_ID=...
SESSION_ID=...
```

Disable permanently:

```
/prose run ... --no-telemetry
```

Telemetry posts are best-effort; failures do not block execution.

## Security + approvals

Treat `.prose` files like code. Review before running. Use Clawdbot tool allowlists and approval gates to control side effects.

For deterministic, approval-gated workflows, compare with [Lobster](/tools/lobster).
