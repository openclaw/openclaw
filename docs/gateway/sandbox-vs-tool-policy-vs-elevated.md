---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: Sandbox vs Tool Policy vs Elevated（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Why a tool is blocked: sandbox runtime, tool allow/deny policy, and elevated exec gates"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when: "You hit 'sandbox jail' or see a tool/elevated refusal and want the exact config key to change."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
status: active（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Sandbox vs Tool Policy vs Elevated（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw has three related (but different) controls:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Sandbox** (`agents.defaults.sandbox.*` / `agents.list[].sandbox.*`) decides **where tools run** (Docker vs host).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Tool policy** (`tools.*`, `tools.sandbox.tools.*`, `agents.list[].tools.*`) decides **which tools are available/allowed**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Elevated** (`tools.elevated.*`, `agents.list[].tools.elevated.*`) is an **exec-only escape hatch** to run on the host when you’re sandboxed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick debug（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use the inspector to see what OpenClaw is _actually_ doing:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw sandbox explain（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw sandbox explain --session agent:main:main（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw sandbox explain --agent work（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw sandbox explain --json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
It prints:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- effective sandbox mode/scope/workspace access（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- whether the session is currently sandboxed (main vs non-main)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- effective sandbox tool allow/deny (and whether it came from agent/global/default)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- elevated gates and fix-it key paths（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Sandbox: where tools run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Sandboxing is controlled by `agents.defaults.sandbox.mode`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `"off"`: everything runs on the host.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `"non-main"`: only non-main sessions are sandboxed (common “surprise” for groups/channels).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `"all"`: everything is sandboxed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Sandboxing](/gateway/sandboxing) for the full matrix (scope, workspace mounts, images).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Bind mounts (security quick check)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `docker.binds` _pierces_ the sandbox filesystem: whatever you mount is visible inside the container with the mode you set (`:ro` or `:rw`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default is read-write if you omit the mode; prefer `:ro` for source/secrets.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `scope: "shared"` ignores per-agent binds (only global binds apply).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Binding `/var/run/docker.sock` effectively hands host control to the sandbox; only do this intentionally.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Workspace access (`workspaceAccess: "ro"`/`"rw"`) is independent of bind modes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Tool policy: which tools exist/are callable（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Two layers matter:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Tool profile**: `tools.profile` and `agents.list[].tools.profile` (base allowlist)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Provider tool profile**: `tools.byProvider[provider].profile` and `agents.list[].tools.byProvider[provider].profile`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Global/per-agent tool policy**: `tools.allow`/`tools.deny` and `agents.list[].tools.allow`/`agents.list[].tools.deny`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Provider tool policy**: `tools.byProvider[provider].allow/deny` and `agents.list[].tools.byProvider[provider].allow/deny`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Sandbox tool policy** (only applies when sandboxed): `tools.sandbox.tools.allow`/`tools.sandbox.tools.deny` and `agents.list[].tools.sandbox.tools.*`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Rules of thumb:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `deny` always wins.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If `allow` is non-empty, everything else is treated as blocked.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tool policy is the hard stop: `/exec` cannot override a denied `exec` tool.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/exec` only changes session defaults for authorized senders; it does not grant tool access.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Provider tool keys accept either `provider` (e.g. `google-antigravity`) or `provider/model` (e.g. `openai/gpt-5.2`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Tool groups (shorthands)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tool policies (global, agent, sandbox) support `group:*` entries that expand to multiple tools:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    sandbox: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        allow: ["group:runtime", "group:fs", "group:sessions", "group:memory"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Available groups:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `group:runtime`: `exec`, `bash`, `process`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `group:fs`: `read`, `write`, `edit`, `apply_patch`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `group:memory`: `memory_search`, `memory_get`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `group:ui`: `browser`, `canvas`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `group:automation`: `cron`, `gateway`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `group:messaging`: `message`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `group:nodes`: `nodes`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `group:openclaw`: all built-in OpenClaw tools (excludes provider plugins)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Elevated: exec-only “run on host”（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Elevated does **not** grant extra tools; it only affects `exec`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you’re sandboxed, `/elevated on` (or `exec` with `elevated: true`) runs on the host (approvals may still apply).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `/elevated full` to skip exec approvals for the session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you’re already running direct, elevated is effectively a no-op (still gated).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Elevated is **not** skill-scoped and does **not** override tool allow/deny.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/exec` is separate from elevated. It only adjusts per-session exec defaults for authorized senders.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Gates:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Enablement: `tools.elevated.enabled` (and optionally `agents.list[].tools.elevated.enabled`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sender allowlists: `tools.elevated.allowFrom.<provider>` (and optionally `agents.list[].tools.elevated.allowFrom.<provider>`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Elevated Mode](/tools/elevated).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Common “sandbox jail” fixes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### “Tool X blocked by sandbox tool policy”（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Fix-it keys (pick one):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Disable sandbox: `agents.defaults.sandbox.mode=off` (or per-agent `agents.list[].sandbox.mode=off`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Allow the tool inside sandbox:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - remove it from `tools.sandbox.tools.deny` (or per-agent `agents.list[].tools.sandbox.tools.deny`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - or add it to `tools.sandbox.tools.allow` (or per-agent allow)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### “I thought this was main, why is it sandboxed?”（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
In `"non-main"` mode, group/channel keys are _not_ main. Use the main session key (shown by `sandbox explain`) or switch mode to `"off"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
