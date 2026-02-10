---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "What the OpenClaw system prompt contains and how it is assembled"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Editing system prompt text, tools list, or time/heartbeat sections（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Changing workspace bootstrap or skills injection behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "System Prompt"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# System Prompt（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw builds a custom system prompt for every agent run. The prompt is **OpenClaw-owned** and does not use the p-coding-agent default prompt.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The prompt is assembled by OpenClaw and injected into each agent run.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Structure（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The prompt is intentionally compact and uses fixed sections:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Tooling**: current tool list + short descriptions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Safety**: short guardrail reminder to avoid power-seeking behavior or bypassing oversight.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Skills** (when available): tells the model how to load skill instructions on demand.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **OpenClaw Self-Update**: how to run `config.apply` and `update.run`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Workspace**: working directory (`agents.defaults.workspace`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Documentation**: local path to OpenClaw docs (repo or npm package) and when to read them.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Workspace Files (injected)**: indicates bootstrap files are included below.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Sandbox** (when enabled): indicates sandboxed runtime, sandbox paths, and whether elevated exec is available.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Current Date & Time**: user-local time, timezone, and time format.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Reply Tags**: optional reply tag syntax for supported providers.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Heartbeats**: heartbeat prompt and ack behavior.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Runtime**: host, OS, node, model, repo root (when detected), thinking level (one line).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Reasoning**: current visibility level + /reasoning toggle hint.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Safety guardrails in the system prompt are advisory. They guide model behavior but do not enforce policy. Use tool policy, exec approvals, sandboxing, and channel allowlists for hard enforcement; operators can disable these by design.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Prompt modes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw can render smaller system prompts for sub-agents. The runtime sets a（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`promptMode` for each run (not a user-facing config):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `full` (default): includes all sections above.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `minimal`: used for sub-agents; omits **Skills**, **Memory Recall**, **OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Self-Update**, **Model Aliases**, **User Identity**, **Reply Tags**,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  **Messaging**, **Silent Replies**, and **Heartbeats**. Tooling, **Safety**,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Workspace, Sandbox, Current Date & Time (when known), Runtime, and injected（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context stay available.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `none`: returns only the base identity line.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When `promptMode=minimal`, extra injected prompts are labeled **Subagent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Context** instead of **Group Chat Context**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Workspace bootstrap injection（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Bootstrap files are trimmed and appended under **Project Context** so the model sees identity and profile context without needing explicit reads:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `AGENTS.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `SOUL.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `TOOLS.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `IDENTITY.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `USER.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `HEARTBEAT.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `BOOTSTRAP.md` (only on brand-new workspaces)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `MEMORY.md` and/or `memory.md` (when present in the workspace; either or both may be injected)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
All of these files are **injected into the context window** on every turn, which（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
means they consume tokens. Keep them concise — especially `MEMORY.md`, which can（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
grow over time and lead to unexpectedly high context usage and more frequent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
compaction.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
> **Note:** `memory/*.md` daily files are **not** injected automatically. They（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
> are accessed on demand via the `memory_search` and `memory_get` tools, so they（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
> do not count against the context window unless the model explicitly reads them.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Large files are truncated with a marker. The max per-file size is controlled by（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`agents.defaults.bootstrapMaxChars` (default: 20000). Missing files inject a（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
short missing-file marker.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Sub-agent sessions only inject `AGENTS.md` and `TOOLS.md` (other bootstrap files（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
are filtered out to keep the sub-agent context small).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Internal hooks can intercept this step via `agent:bootstrap` to mutate or replace（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
the injected bootstrap files (for example swapping `SOUL.md` for an alternate persona).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To inspect how much each injected file contributes (raw vs injected, truncation, plus tool schema overhead), use `/context list` or `/context detail`. See [Context](/concepts/context).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Time handling（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The system prompt includes a dedicated **Current Date & Time** section when the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
user timezone is known. To keep the prompt cache-stable, it now only includes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
the **time zone** (no dynamic clock or time format).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `session_status` when the agent needs the current time; the status card（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
includes a timestamp line.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Configure with:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.defaults.userTimezone`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.defaults.timeFormat` (`auto` | `12` | `24`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Date & Time](/date-time) for full behavior details.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Skills（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When eligible skills exist, OpenClaw injects a compact **available skills list**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
(`formatSkillsForPrompt`) that includes the **file path** for each skill. The（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
prompt instructs the model to use `read` to load the SKILL.md at the listed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
location (workspace, managed, or bundled). If no skills are eligible, the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Skills section is omitted.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<available_skills>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <skill>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    <name>...</name>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    <description>...</description>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    <location>...</location>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </skill>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</available_skills>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This keeps the base prompt small while still enabling targeted skill usage.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Documentation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When available, the system prompt includes a **Documentation** section that points to the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
local OpenClaw docs directory (either `docs/` in the repo workspace or the bundled npm（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
package docs) and also notes the public mirror, source repo, community Discord, and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ClawHub ([https://clawhub.com](https://clawhub.com)) for skills discovery. The prompt instructs the model to consult local docs first（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
for OpenClaw behavior, commands, configuration, or architecture, and to run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`openclaw status` itself when possible (asking the user only when it lacks access).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
