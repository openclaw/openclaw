---
summary: "Exec tool usage, stdin modes, and TTY support"
read_when:
  - Using or modifying the exec tool
  - Debugging stdin or TTY behavior
title: "Exec tool"
---

Run shell commands in the workspace. `exec` is a mutating shell surface: commands can create, edit, or delete files wherever the selected host or sandbox filesystem permits. Disabling OpenClaw filesystem tools such as `write`, `edit`, or `apply_patch` does not make `exec` read-only.

Supports foreground and background execution via `process`. If `process` is disallowed, `exec` runs synchronously and ignores `yieldMs`/`background`. Background sessions are scoped per agent; `process` only sees sessions from the same agent.

## Parameters

<ParamField path="command" type="string" required>
Shell command to run.
</ParamField>

<ParamField path="workdir" type="string" default="cwd">
Working directory for the command.
</ParamField>

<ParamField path="env" type="object">
Key/value environment overrides merged on top of the inherited environment.
</ParamField>

<ParamField path="yieldMs" type="number" default="10000">
Auto-background the command after this delay (ms).
</ParamField>

<ParamField path="background" type="boolean" default="false">
Background the command immediately instead of waiting for `yieldMs`. The process timeout still applies after the tool returns.
</ParamField>

<ParamField path="timeoutSeconds" type="number" default="tools.exec.timeoutSeconds">
Limit the command's total lifetime, in **seconds**, overriding the configured exec timeout for this call. Expiry terminates the process even after `background` or `yieldMs` returns a session ID. `yieldMs` controls how long the tool waits before backgrounding; the `process` tool's `timeout` controls how long a poll waits, also in milliseconds.

Applies to gateway, sandbox, and node `system.run` execution. `timeoutSeconds: 0` disables the exec process timeout for that call. For a persistent service on the gateway or in a sandbox, use `background: true` with `timeoutSeconds: 0`, then stop it with `process` action `kill` when finished. Disabling this timeout does not make the process survive its host or worker shutting down.
</ParamField>

<ParamField path="pty" type="boolean" default="false">
Run in a pseudo-terminal when available. Use for TTY-only CLIs, coding agents, and terminal UIs.
</ParamField>

<ParamField path="host" type="'auto' | 'sandbox' | 'gateway' | 'node'" default="auto">
Where to execute. Omit `host` or use `auto` to inherit the configured exec host, including agent and session overrides. When that configured host is also `auto`, it resolves to `sandbox` when a sandbox runtime is active and `gateway` otherwise. A session that requires a sandbox stays sandboxed regardless of the configured host.
</ParamField>

<ParamField path="ask" type="'off' | 'on-miss' | 'always'">
The baseline ask mode is derived from `tools.exec.mode` and host approvals. For channel-origin model calls, per-call `ask` is ignored when the effective host ask is `off`; otherwise it can only harden to a stricter mode.
</ParamField>

<ParamField path="node" type="string">
Node id/name when `host=node`.
</ParamField>

<ParamField path="elevated" type="boolean" default="false">
Request elevated mode: escape the sandbox onto the configured host path when the operator permits it. Elevated `full` skips approvals only when the effective security and ask policy already allow `full` and `off`.
</ParamField>

Notes:

- `host` only accepts `auto`, `sandbox`, `gateway`, or `node`. It is not a hostname selector; hostname-like values are rejected before the command runs.
- Per-call `host=node` and `host=gateway` are allowed from `auto` only when no sandbox runtime is active. While a sandbox runtime is active, `auto` keeps exec in the sandbox and rejects both overrides; set `tools.exec.host=node` (or `gateway`) explicitly to run there.
- With no extra config, `host=auto` still "just works": no sandbox means it resolves to `gateway`; a live sandbox means it stays in the sandbox.
- `elevated` escapes the sandbox onto the configured host path: `gateway` by default, or `node` when `tools.exec.host=node` (or the session default is `host=node`). It is only available when elevated access is enabled for the current session/provider.
- `gateway`/`node` approvals are controlled by the host approvals file.
- `node` requires a paired, connected node that supports `system.run` (companion app or headless node host). With no target set, exec selects the sole eligible node. If multiple eligible nodes are connected, set `exec.node`, `tools.exec.node`, or `/exec node=...` to select one; it never uses the active Canvas target. An explicit or bound target must itself be connected and executable. Completed results identify the selected node alongside command output.
- `exec host=node` is the only shell-execution path for nodes; the legacy `nodes.run` wrapper was removed in 2026.3.31.
- On non-Windows hosts, exec uses `SHELL` when set; if `SHELL` is `fish`, it prefers `bash` (or `sh`) from `PATH` to avoid fish-incompatible bashisms, then falls back to `SHELL` if neither exists.
- On Windows hosts, exec prefers PowerShell 7 (`pwsh`) discovery (Program Files, ProgramW6432, then PATH), then falls back to Windows PowerShell 5.1.
- On non-Windows gateway hosts, bash and zsh exec commands use a startup snapshot. OpenClaw captures sourceable aliases/functions and a small safe environment set from shell startup files into `$OPENCLAW_STATE_DIR/cache/shell-snapshots/`, then sources that snapshot before each exec command. Secret-looking variables are excluded; sandbox and node exec do not use this snapshot. Set `OPENCLAW_EXEC_SHELL_SNAPSHOT=0` in the Gateway process environment to disable this snapshot path.
- Host execution (`gateway`/`node`) rejects `env.PATH` and loader overrides (`LD_*`/`DYLD_*`) to prevent binary hijacking or injected code.
- Exact `"cat"` or empty `GIT_PAGER` and `PAGER` overrides are normalized to empty values, including on node shell-wrapper execution. This disables Git paging without passing an executable pager name through `PATH`. Other programs may interpret an empty `PAGER` differently; use their noninteractive flags when needed. Other pager commands, paths, whitespace variants, and `MANPAGER` overrides remain blocked.
- OpenClaw sets `OPENCLAW_SHELL=exec` in the spawned command environment (including PTY and sandbox execution) so shell/profile rules can detect exec-tool context.
- With the default-off [secret egress proxy](/gateway/secrets#secret-egress-proxy), Gateway-hosted exec receives shared-store `secret` entries only as process-local sentinels. The authenticated loopback proxy substitutes plaintext at outbound HTTPS request time; the exact run token expires when the agent run closes.
- Shared-store `env` entries are intentionally plaintext and reach Gateway-hosted exec from the next agent run. They do not reach sandbox, remote `node`, ACP, or Codex-native shell execution. Under the Codex harness, use `gateway_exec` for this OpenClaw-managed environment path.
- With a [managed GitHub identity](/gateway/config-tools#tools.github), Gateway-hosted exec validates the selected profile and binds its credential privately at each process launch. An unavailable profile blocks that local execution with reconnect guidance instead of falling back to native keyring credentials. Running shells retain their launch token; later exec launches observe refreshes. Codex-native shell does not share this launch binding.
- Secret egress sets `NODE_USE_ENV_PROXY=1` so supported Node.js global `fetch` clients honor the run-scoped proxy. It does not use `NODE_OPTIONS`.
- For channel-origin runs, OpenClaw also exposes a narrow sender/chat identity JSON payload in `OPENCLAW_CHANNEL_CONTEXT` when the channel provided those ids.
- `exec` cannot run `openclaw channels login` or `/approve` shell commands: `openclaw channels login` is an interactive channel-auth flow, and `/approve` needs to go through the approval command handler, not a shell. Run channel login in a terminal on the gateway host, or use a channel-specific login agent tool when one exists (for example `whatsapp_login`).
- Important: sandboxing is **off by default**. If sandboxing is off, implicit `host=auto` resolves to `gateway`. Explicit `host=sandbox` still fails closed instead of silently running on the gateway host. Enable sandboxing or use `host=gateway` with approvals.
- Script preflight checks (for common Python/Node shell-syntax mistakes) only inspect files inside the effective `workdir` boundary. If a script path resolves outside `workdir`, preflight is skipped for that file. Preflight also skips entirely when `host=gateway` and the effective policy is `security=full` with `ask=off`.
- For long-running work that starts now, start it once and rely on automatic completion wake when it is enabled and the command emits output or fails. Use `process` for logs, status, input, or intervention; do not emulate scheduling with sleep loops, timeout loops, or repeated polling.
- Agent-started background commands appear in the Web, iOS, and Android background-task views until they finish. The task ledger is finalized before the completion heartbeat wakes the agent again.
- For work that should happen later or on a schedule, use cron instead of `exec` sleep/delay patterns.

## Config

| Key                                  | Default                  | Notes                                                                                                                                                   |
| ------------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools.exec.timeoutSeconds`          | `1800`                   | Default per-command exec timeout in seconds. Per-call `timeoutSeconds` overrides it; per-call `timeoutSeconds: 0` disables the exec process timeout.    |
| `tools.exec.host`                    | `auto`                   | Resolves to `sandbox` when a sandbox runtime is active, `gateway` otherwise.                                                                            |
| `tools.exec.mode`                    | host-derived             | Canonical policy knob. See [Modes](#modes) below.                                                                                                       |
| `tools.exec.reviewer.model`          | configured agent primary | Optional provider/model override for `mode=auto` review.                                                                                                |
| `tools.exec.reviewer.timeoutMs`      | `30000`                  | Per-stage timeout for reviewer model preparation and completion before human fallback.                                                                  |
| `tools.exec.node`                    | unset                    |                                                                                                                                                         |
| `tools.exec.notifyOnExit`            | `true`                   | When true, backgrounded exec sessions enqueue a system event and request a heartbeat on exit.                                                           |
| `tools.exec.approvalRunningNoticeMs` | `10000`                  | Emit a single "running" notice when an approval-gated exec runs longer than this (`0` disables).                                                        |
| `tools.exec.strictInlineEval`        | `false`                  | See [Inline eval](#inline-eval-strictinlineeval).                                                                                                       |
| `tools.exec.commandHighlighting`     | `false`                  | When true, approval prompts can highlight parser-derived command spans in the command text. Set globally or per agent; does not change approval policy. |
| `tools.exec.pathPrepend`             | unset                    | List of directories to prepend to `PATH` for exec runs (gateway + sandbox only).                                                                        |
| `tools.exec.safeBins`                | unset                    | Stdin-only safe binaries that can run without explicit allowlist entries. See [Safe bins](/tools/exec-approvals-advanced#safe-bins-stdin-only).         |
| `tools.exec.safeBinTrustedDirs`      | `/bin`, `/usr/bin`       | Additional explicit directories trusted for `safeBins` path checks. `PATH` entries are never auto-trusted.                                              |
| `tools.exec.safeBinProfiles`         | unset                    | Optional custom argv policy per safe bin (`minPositional`, `maxPositional`, `allowedValueFlags`, `deniedFlags`).                                        |

No-approval host exec is the default for gateway and node (`mode=full`) — this comes from the host-policy defaults, not from `host=auto`. If you want approvals/allowlist behavior, set `tools.exec.mode` and tighten the host approvals file; see [Exec approvals](/tools/exec-approvals#yolo-mode-no-approval). To force gateway or node routing regardless of sandbox state, set `tools.exec.host` or use `/exec host=...`.

Example:

```json5
{
  tools: {
    exec: {
      pathPrepend: ["~/bin", "/opt/oss/bin"],
    },
  },
}
```

### Modes

`tools.exec.mode` is the canonical persisted policy knob. Runtime security and approval behavior are derived from it.

| Mode        | security    | ask       | Behavior                                                                                                                        |
| ----------- | ----------- | --------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `deny`      | `deny`      | `off`     | Exec is denied.                                                                                                                 |
| `allowlist` | `allowlist` | `off`     | Only allowlisted/safe-bin commands run; nothing else is asked.                                                                  |
| `ask`       | `allowlist` | `on-miss` | Allowlist matches run directly; everything else asks a human.                                                                   |
| `auto`      | `allowlist` | `on-miss` | Allowlist/safe-bin matches run directly; eligible misses receive an `allow`, `deny`, or `ask` verdict from the native reviewer. |
| `full`      | `full`      | `off`     | No ordinary policy prompts; see [strict inline eval](#inline-eval-strictinlineeval).                                            |

Use `/exec ask=always` with a message to require human approval for that run. It does not persist to later messages. Use [session permission modes](/gateway/permission-modes) for session-wide policy.

Auto-review approval is single-use. The reviewer returns `allow`, `deny`, or `ask`: `allow` runs a low- or medium-risk command once; `deny` returns a reason to the agent, which must choose a materially safer alternative or ask the user rather than work around the denial; `ask` requests human approval. Commands containing reviewer-directed text are denied back to the agent so it can rewrite the command; they do not directly escalate to human approval. Reviewer failures, timeouts, and invalid responses also ask a human. On the gateway, three consecutive reviewer denials for a session escalate the third command to human approval; a reviewer allowance or resolved human approval resets the count.

Model preparation and completion each receive the configured `tools.exec.reviewer.timeoutMs` budget. A timeout returns to human approval immediately; pending preparation and provider cleanup remain owned until they settle. Preparation that finishes after its timeout does not start a review.

For embedded agent runs, the reviewer receives a bounded, redacted excerpt of the current conversation: user requests, assistant text, tool calls, and tool results, labeled by origin. It uses this context to judge whether a command serves the user's request. The excerpt is untrusted evidence, not instructions. Conversation context is unavailable for direct node `system.run` calls and widgets.

On the gateway, commands must still pass the existing mutable-file binding checks before review. Those checks continue to reject heredocs, unresolved executables, and missing script operands. The whole ordinary external dispatch chain—each original wrapper executable and the final command-segment executable—is bound at review time and re-checked before launch: protected executables use resolved real-path identity only, while writable executables also use a content hash. A changed executable resolution, including a new executable earlier on `PATH`, denies the approved run. Identity-only binding does not make an otherwise eligible human approval single-use.

Reviewer-approved unpinned execution requires the complete dispatch chain to be identity-bound: the authorization plan must be complete, use direct transports, and have a recorded executable operand for every wrapper and final executable. Eligible globs and chains run as written after executable-identity, mutable-file, and working-directory revalidation. Commands rebuilt with pinned executable paths retain their existing review behavior. Node-host auto-review accepts a prepared pinned direct command, including the node's own canonical POSIX shell transport around one direct absolute executable with static arguments. Bare executable names, unquoted globs, and user-supplied wrappers still require human approval when the gateway cannot inspect the node's in-memory binding. Node executable-identity revalidation covers local policy evaluation through dispatch; it does not preserve every inner shell executable's identity across a remote human approval wait. See [Interpreter/runtime commands](/tools/exec-approvals-advanced#interpreter%2Fruntime-commands) for that boundary.

Shell `-c` wrappers, `env` with assignments, `xcrun`, BusyBox/Toybox applets, shell `builtin`/`command`/`exec` dispatch, and any other incomplete dispatch chain skip the reviewer with `Exec auto-review skipped: dispatch chain cannot be bound`. In auto mode, these forms take the one-shot human approval path when existing binding checks succeed; existing binding rejections still apply. Plain commands and transparent `env` without assignments remain eligible when their complete chains are bound. There are no persisted data model changes: binding stays in memory for the approval lifetime.

POSIX login or interactive shell wrappers in the requested command never receive auto-review. When binding succeeds, as with `bash -lc 'printf ok'`, they require human approval because their implicit startup files are outside operand binding. Existing binding rejections still take precedence; interactive forms rejected as code-loading options remain denied. This applies to wrappers in the requested command; the gateway's ordinary shell startup snapshot is unchanged.

Explicit `ask=always`, security-audit suppression changes, and commands above the review candidate limit go directly to human approval.

Codex app-server command approvals that are not already decided by explicit runtime or native policy use the human approval route. OpenClaw does not run its configured exec reviewer for these requests because Codex does not expose an enforceable resolved executable that can bind the review decision to the command Codex runs.

### Inline eval (`strictInlineEval`)

`tools.exec.strictInlineEval` is a separate opt-in setting and defaults to `false`. When ordinary host approval evaluation runs, enabling it requires reviewer or explicit approval for recognized inline interpreter-eval forms, even when exec and host policies allow `full`/`off`. Examples include `python -c`, `node -e`, `ruby -e`, `perl -e`, `php -r`, `lua -e`, `osascript -e`, and similar forms across other supported interpreters and command carriers (`awk`, `find -exec`, `make`, `sed`, `xargs`, and more). In `mode=auto`, the normal exec approval path may let the native auto reviewer allow a low- or medium-risk one-off command; direct node-host `system.run` calls still require an explicit approval because they cannot hand the command to a human approval route. A reviewer denial returns to the agent with a reason; `ask` goes to a human. `allow-always` can still persist benign interpreter/script invocations, but inline-eval forms do not become durable allow rules.

Configured `tools.exec.mode: "full"` alone does not skip this check. Gateway execution skips the host approval path in either of these cases:

- A full-permission session keeps effective security `full` and ask `off`.
- Elevated-full execution is permitted and both the exec policy and host approvals allow `full`/`off`.

These paths skip the approval owner that detects strict inline evaluation. Tightening a full session's ask mode restores that evaluation, even when the session still bypasses host approval-file floors. See [Session permission modes](/gateway/permission-modes) and [Elevated mode](/tools/elevated).

For ordinary configured full/off execution without prompts for these forms, leave `strictInlineEval` unset or set it to `false`. `askFallback: "full"` does not satisfy strict inline-eval approval when detection runs.

### PATH handling

- `host=gateway`: merges your login-shell `PATH` into the exec environment. `env.PATH` overrides are rejected for host execution. The daemon itself still runs with a minimal `PATH`:
  - macOS: `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`
  - Linux: `/usr/local/bin`, `/usr/bin`, `/bin`
  - To prevent user shell configuration (like `~/.zshenv` or `/etc/zshenv`) from overriding priority paths during startup, `tools.exec.pathPrepend` entries are securely prepended to the final `PATH` inside the shell command right before execution.
- `host=sandbox`: runs `sh -lc` (login shell) inside the container, so `/etc/profile` may reset `PATH`. OpenClaw prepends `env.PATH` after profile sourcing via an internal env var (no shell interpolation); `tools.exec.pathPrepend` applies here too.
- `host=node`: only non-blocked env overrides you pass are sent to the node. `env.PATH` overrides are rejected for host execution and ignored by node hosts. If you need additional PATH entries on a node, configure the node host service environment (systemd/launchd) or install tools in standard locations.

Per-agent node binding (use the keyed agent ID in config):

```bash
openclaw config get agents.entries
openclaw config set 'agents.entries.main.tools.exec.node' "node-id-or-name"
```

Control UI: the **Devices** page includes a small "Exec node binding" panel for the same settings. If a saved target cannot be resolved or no longer advertises execution support, its binding stays selected and is marked **Unavailable**. Supported names, addresses, and ID prefixes resolve without rewriting the saved reference.

### Python environments (`uv`)

In a [uv-managed project](https://docs.astral.sh/uv/guides/projects/), a bare `python` or `python3` uses the interpreter selected by the exec host's `PATH`. If the project environment is not on that path, imports of dependencies installed there can fail with `ModuleNotFoundError`.

Set `workdir` to the project directory and run `uv run python3 script.py` to use its environment. A bare interpreter also works when the project environment is already on `PATH`.

For repeated agent work, record the project convention in the workspace's `AGENTS.md`, for example:

```md
- Run Python scripts from this project with `uv run python3 script.py` so they use its dependencies.
```

## Session overrides (`/exec`)

Send `/exec host=... node=...` on its own to set **per-session** placement defaults. `security` and `ask` apply to the **current message only**; include them with the task you want to run. Send `/exec` with no arguments to show the resolved defaults.

Example:

```text
/exec host=node node=worker-1
/exec security=allowlist ask=always inspect the build output
```

`/exec` is only honored for **authorized senders** through channel allowlists/pairing and access groups. Access-group enforcement is always on. It does not write config. Authorized external channel senders may persist placement defaults; internal gateway/webchat clients need `operator.admin` to do so. Turn-scoped `security` and `ask` do not require that persistence permission.

A standalone `/exec security=deny` acknowledges the run-only setting but starts no agent run and does not affect the next message. Use [session permission modes](/gateway/permission-modes) to keep a policy across messages.

The `execSecurity` and `execAsk` fields in `sessions.patch` and `sessions.patchMany` are retired. They remain in the protocol v4 wire schema, but requests containing either field (including `null`) are rejected with `INVALID_REQUEST` and replacement guidance. Set `permissionMode` (`read-only`, `guarded`, `workspace`, or `full`) for session-wide policy, or use `/exec` with a message for a single run.

When a session has a permission mode, per-turn `/exec` overrides can only tighten its security and approval policy. For example, `/exec security=deny` blocks exec for that turn even in a full-access session; an override requesting looser security or fewer approvals leaves the session mode's limits unchanged. Full-access sessions bypass host approval-file floors only while effective security remains `full`. Tightening `ask` alone still applies the requested approval level without restoring those floors.

To hard-disable exec, deny it via tool policy (`tools.deny: ["exec"]` or per-agent). Outside the full-access session exception above, host approval-file floors still apply.

## Exec approvals (companion app / node host)

Sandboxed agents can require per-request approval before `exec` runs on the gateway or node host. See [Exec approvals](/tools/exec-approvals) for the policy, allowlist, and UI flow.

When a human approval can be delivered, ordinary Gateway and node exec calls wait within the current tool call and return the command result after approval. Flows that explicitly request asynchronous follow-up return immediately with `status: "approval-pending"` and an approval id. An `approval-pending` result means the command has not started, so foreground fallback warnings appear only if the approved command actually runs inline. Approved asynchronous runs emit command progress and completion system events (`Exec running` / `Exec finished`). Denied or timed-out approvals are terminal for the host command; see [System events and denials](/tools/exec-approvals#system-events-and-denials) for notification behavior.

On channels with native approval cards/buttons, the agent should rely on that native UI first and only include a manual `/approve` command when the tool result explicitly says chat approvals are unavailable or manual approval is the only path.

## Allowlist + safe bins

Manual allowlist enforcement matches resolved binary path globs and bare command-name globs. Bare names match only commands invoked through PATH, so `rg` can match `/opt/homebrew/bin/rg` when the command is `rg`, but not `./rg` or `/tmp/rg`.

When `security=allowlist`, shell commands are auto-allowed only if every pipeline segment is allowlisted or a safe bin. Chaining (`;`, `&&`, `||`) and redirections are rejected in allowlist mode unless every top-level segment satisfies the allowlist (including safe bins). Redirections remain unsupported. Durable `allow-always` trust does not bypass that rule: a chained command still requires every top-level segment to match.

`autoAllowSkills` is a separate convenience path in exec approvals, not the same as manual path allowlist entries. For strict explicit trust, keep `autoAllowSkills` disabled.

Use the two controls for different jobs:

- `tools.exec.safeBins`: small, stdin-only stream filters.
- `tools.exec.safeBinTrustedDirs`: explicit extra trusted directories for safe-bin executable paths.
- `tools.exec.safeBinProfiles`: explicit argv policy for custom safe bins.
- allowlist: explicit trust for executable paths.

Do not treat `safeBins` as a generic allowlist, and do not add interpreter/runtime binaries (for example `python3`, `node`, `ruby`, `bash`). If you need those, use explicit allowlist entries and keep approval prompts enabled.

`openclaw security audit` warns when interpreter/runtime `safeBins` entries are missing explicit profiles, and `openclaw doctor --fix` can scaffold missing custom `safeBinProfiles` entries. `openclaw security audit` and `openclaw doctor` also warn when you explicitly add broad-behavior bins such as `jq` back into `safeBins` (`jq` can read environment data and load jq code from modules or startup files, so prefer explicit allowlist entries or approval-gated runs instead). `jq` is denied as a safe bin even when it is explicitly listed. If you explicitly allowlist interpreters, enable `tools.exec.strictInlineEval` to require reviewer or explicit approval for recognized inline forms on the [ordinary approval path](#inline-eval-strictinlineeval).

For full policy details and examples, see [Exec approvals](/tools/exec-approvals-advanced#safe-bins-stdin-only) and [Safe bins versus allowlist](/tools/exec-approvals-advanced#safe-bins-versus-allowlist).

## Examples

Foreground:

```json
{ "tool": "exec", "command": "ls -la" }
```

Background + poll:

```json
{"tool":"exec","command":"npm run build","yieldMs":1000}
{"tool":"process","action":"poll","sessionId":"<id>"}
```

Polling is for on-demand status, not waiting loops. If automatic completion wake is enabled, the command can wake the session when it emits output or fails.

Send keys (tmux-style):

```json
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Enter"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["C-c"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Up","Up","Enter"]}
```

For text, use `literal`; for exact input bytes, use `hex`. A mixed request sends literal UTF-8 text, hex bytes, then named keys, in that order:

```json
{
  "tool": "process",
  "action": "send-keys",
  "sessionId": "<id>",
  "literal": "hello ",
  "hex": ["c3", "a9"],
  "keys": ["Enter"]
}
```

Submit (send CR only):

```json
{ "tool": "process", "action": "submit", "sessionId": "<id>" }
```

Paste (bracketed by default):

```json
{ "tool": "process", "action": "paste", "sessionId": "<id>", "text": "line1\nline2\n" }
```

## apply_patch

`apply_patch` is a subtool of `exec` for structured multi-file edits. It is enabled by default and available to any model provider; `allowModels` can restrict it. Use config only when you want to disable it or restrict it to specific models:

```json5
{
  tools: {
    exec: {
      applyPatch: { workspaceOnly: true, allowModels: ["gpt-5.6-sol"] },
    },
  },
}
```

Notes:

- Tool policy still applies; `allow: ["write"]` implicitly allows `apply_patch`.
- `deny: ["write"]` does not deny `apply_patch`; deny `apply_patch` explicitly or use `deny: ["group:fs"]` when patch writes should also be blocked.
- Config lives under `tools.exec.applyPatch`.
- `tools.exec.applyPatch.enabled` defaults to `true`; set it to `false` to disable the tool.
- `tools.exec.applyPatch.workspaceOnly` defaults to `true` (workspace-contained). Set it to `false` only if you intentionally want `apply_patch` to write/delete outside the workspace directory.
- `tools.exec.applyPatch.allowModels` is an optional allowlist of model ids (raw, like `gpt-5.4`, or full, like `openai/gpt-5.4`). When set, only matching models get the tool; when unset, all models get it.

## Related

- [Exec Approvals](/tools/exec-approvals) — approval gates for shell commands
- [Sandboxing](/gateway/sandboxing) — running commands in sandboxed environments
- [Background Process](/gateway/background-process) — long-running exec and process tool
- [Security](/gateway/security) — tool policy and elevated access
