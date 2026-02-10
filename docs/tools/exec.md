---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Exec tool usage, stdin modes, and TTY support"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Using or modifying the exec tool（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Debugging stdin or TTY behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Exec Tool"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Exec tool（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Run shell commands in the workspace. Supports foreground + background execution via `process`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If `process` is disallowed, `exec` runs synchronously and ignores `yieldMs`/`background`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Background sessions are scoped per agent; `process` only sees sessions from the same agent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Parameters（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `command` (required)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `workdir` (defaults to cwd)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `env` (key/value overrides)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `yieldMs` (default 10000): auto-background after delay（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `background` (bool): background immediately（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `timeout` (seconds, default 1800): kill on expiry（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `pty` (bool): run in a pseudo-terminal when available (TTY-only CLIs, coding agents, terminal UIs)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `host` (`sandbox | gateway | node`): where to execute（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `security` (`deny | allowlist | full`): enforcement mode for `gateway`/`node`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `ask` (`off | on-miss | always`): approval prompts for `gateway`/`node`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `node` (string): node id/name for `host=node`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `elevated` (bool): request elevated mode (gateway host); `security=full` is only forced when elevated resolves to `full`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `host` defaults to `sandbox`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `elevated` is ignored when sandboxing is off (exec already runs on the host).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway`/`node` approvals are controlled by `~/.openclaw/exec-approvals.json`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `node` requires a paired node (companion app or headless node host).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If multiple nodes are available, set `exec.node` or `tools.exec.node` to select one.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- On non-Windows hosts, exec uses `SHELL` when set; if `SHELL` is `fish`, it prefers `bash` (or `sh`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  from `PATH` to avoid fish-incompatible scripts, then falls back to `SHELL` if neither exists.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Host execution (`gateway`/`node`) rejects `env.PATH` and loader overrides (`LD_*`/`DYLD_*`) to（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prevent binary hijacking or injected code.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Important: sandboxing is **off by default**. If sandboxing is off, `host=sandbox` runs directly on（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  the gateway host (no container) and **does not require approvals**. To require approvals, run with（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `host=gateway` and configure exec approvals (or enable sandboxing).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.exec.notifyOnExit` (default: true): when true, backgrounded exec sessions enqueue a system event and request a heartbeat on exit.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.exec.approvalRunningNoticeMs` (default: 10000): emit a single “running” notice when an approval-gated exec runs longer than this (0 disables).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.exec.host` (default: `sandbox`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.exec.security` (default: `deny` for sandbox, `allowlist` for gateway + node when unset)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.exec.ask` (default: `on-miss`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.exec.node` (default: unset)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.exec.pathPrepend`: list of directories to prepend to `PATH` for exec runs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.exec.safeBins`: stdin-only safe binaries that can run without explicit allowlist entries.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    exec: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      pathPrepend: ["~/bin", "/opt/oss/bin"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### PATH handling（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `host=gateway`: merges your login-shell `PATH` into the exec environment. `env.PATH` overrides are（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  rejected for host execution. The daemon itself still runs with a minimal `PATH`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - macOS: `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Linux: `/usr/local/bin`, `/usr/bin`, `/bin`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `host=sandbox`: runs `sh -lc` (login shell) inside the container, so `/etc/profile` may reset `PATH`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  OpenClaw prepends `env.PATH` after profile sourcing via an internal env var (no shell interpolation);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `tools.exec.pathPrepend` applies here too.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `host=node`: only non-blocked env overrides you pass are sent to the node. `env.PATH` overrides are（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  rejected for host execution. Headless node hosts accept `PATH` only when it prepends the node host（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  PATH (no replacement). macOS nodes drop `PATH` overrides entirely.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Per-agent node binding (use the agent list index in config):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config get agents.list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Control UI: the Nodes tab includes a small “Exec node binding” panel for the same settings.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Session overrides (`/exec`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `/exec` to set **per-session** defaults for `host`, `security`, `ask`, and `node`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Send `/exec` with no arguments to show the current values.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/exec host=gateway security=allowlist ask=on-miss node=mac-1（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Authorization model（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`/exec` is only honored for **authorized senders** (channel allowlists/pairing plus `commands.useAccessGroups`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
It updates **session state only** and does not write config. To hard-disable exec, deny it via tool（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
policy (`tools.deny: ["exec"]` or per-agent). Host approvals still apply unless you explicitly set（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`security=full` and `ask=off`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Exec approvals (companion app / node host)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Sandboxed agents can require per-request approval before `exec` runs on the gateway or node host.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Exec approvals](/tools/exec-approvals) for the policy, allowlist, and UI flow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When approvals are required, the exec tool returns immediately with（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`status: "approval-pending"` and an approval id. Once approved (or denied / timed out),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
the Gateway emits system events (`Exec finished` / `Exec denied`). If the command is still（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
running after `tools.exec.approvalRunningNoticeMs`, a single `Exec running` notice is emitted.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Allowlist + safe bins（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Allowlist enforcement matches **resolved binary paths only** (no basename matches). When（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`security=allowlist`, shell commands are auto-allowed only if every pipeline segment is（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
allowlisted or a safe bin. Chaining (`;`, `&&`, `||`) and redirections are rejected in（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
allowlist mode.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Foreground:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{ "tool": "exec", "command": "ls -la" }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Background + poll:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{"tool":"exec","command":"npm run build","yieldMs":1000}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{"tool":"process","action":"poll","sessionId":"<id>"}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Send keys (tmux-style):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Enter"]}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["C-c"]}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Up","Up","Enter"]}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Submit (send CR only):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{ "tool": "process", "action": "submit", "sessionId": "<id>" }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Paste (bracketed by default):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{ "tool": "process", "action": "paste", "sessionId": "<id>", "text": "line1\nline2\n" }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## apply_patch (experimental)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`apply_patch` is a subtool of `exec` for structured multi-file edits.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Enable it explicitly:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    exec: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      applyPatch: { enabled: true, allowModels: ["gpt-5.2"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Only available for OpenAI/OpenAI Codex models.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tool policy still applies; `allow: ["exec"]` implicitly allows `apply_patch`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config lives under `tools.exec.applyPatch`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
