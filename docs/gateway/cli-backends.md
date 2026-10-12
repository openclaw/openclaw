---
summary: "CLI backends: run agent turns through a local AI CLI, with an optional MCP tool bridge"
read_when:
  - You want a reliable fallback when API providers fail
  - You are running local AI CLIs and want to reuse them
  - You want to understand the MCP loopback bridge for CLI backend tool access
title: "CLI backends"
---

OpenClaw can run agent turns through a local AI CLI, such as Claude Code or Gemini CLI, instead of calling the provider API itself:

- A backend with `bundleMcp: true` receives Gateway tools through a loopback MCP bridge. OpenClaw does not inject tool calls into the CLI protocol directly.
- JSONL streaming for CLIs that support it.
- Sessions are supported, so follow-up turns stay coherent.
- Images pass through if the CLI accepts image paths.

A CLI backend can be an agent's primary runtime or a fallback. Choosing **Claude CLI** during onboarding keeps `anthropic/*` model refs and runs them through Claude Code. For ACP session controls, background tasks, thread/conversation binding, and persistent external coding sessions, use [ACP Agents](/tools/acp-agents) instead. CLI backends are not ACP.

<Tip>
  Building a new backend plugin? See [CLI backend plugins](/plugins/cli-backend-plugins). This page covers configuring and operating an already-registered backend.
</Tip>

## Quick start

The bundled Anthropic plugin registers the `claude-cli` backend. With Claude Code installed and logged in on the Gateway host, select it for Anthropic models:

```bash
openclaw models auth login --provider anthropic --method cli --set-default
openclaw agent --agent main --message "hi"
```

The login keeps canonical `anthropic/*` model refs and sets `agentRuntime: { id: "claude-cli" }` on Claude model entries that do not already name a runtime, so `--model anthropic/claude-sonnet-5` also runs through Claude Code. It also adds an `"anthropic/*"` entry with the same runtime, so Claude models that are published after sign-in or typed by ID run through Claude Code too. An entry for a specific model that names another runtime still wins. Choosing **Claude CLI** in `openclaw onboard` writes the same config. Legacy `claude-cli/*` refs still work as compatibility input, and `openclaw doctor --fix` rewrites persisted ones to this canonical form.

Deprecated catalog models are not added at sign-in; an existing entry for one is kept and runs through Claude CLI. Configs from an earlier Claude CLI sign-in lack the `"anthropic/*"` entry, so Claude models that sign-in did not add fail with a missing Anthropic API key. `openclaw doctor --fix` and `openclaw update` add it when the default model is an Anthropic model pinned to `claude-cli`, no `"anthropic/*"` entry exists, and no Anthropic credential is configured (an Anthropic auth profile, provider API key, or `ANTHROPIC_API_KEY`/`ANTHROPIC_OAUTH_TOKEN`). With a credential or an API default model, other Claude models keep their current route.

`main` is the default agent id when no explicit agent list is configured. Swap in your own agent id otherwise.

When you switch an existing chat away from Claude CLI and back, the first resumed turn includes a short count, time range, and model summary of messages since the last saved Claude CLI reply—not their contents. The note prefixes that native user prompt; OpenClaw's transcript keeps the original user text. When `sessions_history` is available, the note includes the current chat's session key and call shape so Claude can read those messages on demand. An empty Claude reply leaves no saved reply boundary, so the note can repeat on the following turn.

When an account change starts a fresh native Claude session in an existing chat, its first turn receives the same kind of note about earlier messages in the chat. This includes opaque native logins. Claude can read that history on demand through `sessions_history` when tool policy allows it; OpenClaw never automatically replays raw transcript content or durable context across the account boundary. A brand-new chat has no earlier-message note.

The gateway service must have the CLI on its `PATH`. If a deployment needs a
nonstandard executable path or arguments, register that adapter in a
[CLI backend plugin](/plugins/cli-backend-plugins) instead of putting launch
mechanics in `openclaw.json`.

OpenClaw auto-loads an owning bundled plugin when model selection or a
model-scoped `agentRuntime.id` references its backend.

Utility completions for Activity recaps, session titles, conversation labels, progress narration, and tool-call titles use the selected model's runtime. Claude CLI runs a fresh, tool-free completion with its own authentication.

When `agents.defaults.utilityModel` is unset, OpenClaw uses the primary provider's declared small model. A Claude CLI primary uses the recommended Haiku model through Claude CLI, even if an Anthropic API credential is also available. It does not automatically switch utility work to the Anthropic API.

An explicitly configured utility model keeps its own runtime. A compatible runtime explicitly selected for the session, or a runtime pinned on the derived model's own entry, also wins over inherited routing. For other runtimes, automatic utility routing can prefer an available provider credential before borrowing the primary model's pinned runtime.

To explicitly use the Anthropic API for utility work, configure its runtime on the utility model:

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-5": { agentRuntime: { id: "claude-cli" } },
        // Always HTTP, even with no provider credential configured.
        "anthropic/claude-haiku-4-5": { agentRuntime: { id: "openclaw" } },
      },
    },
  },
}
```

## Using it as a fallback

To keep the API as the primary route and use Claude Code only when it fails, pin the CLI runtime on the fallback model:

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["anthropic/claude-sonnet-5"],
      },
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "anthropic/claude-sonnet-5": { agentRuntime: { id: "claude-cli" } },
      },
    },
  },
}
```

Configured fallbacks remain eligible when the primary model fails (auth, rate limits, timeouts), even when they are not in `agents.defaults.modelPolicy.allow`. Add the fallback model to that policy only when people should also be able to select it directly. Direct selection means `/model`, a session override, or `--model`. `agents.defaults.models` only owns per-model aliases, parameters, runtime, and metadata.

## Configuration

Users choose a registered backend through the model and runtime policy. Keep
the model ref canonical and select the CLI runtime per model:

```json5
{
  agents: {
    defaults: {
      model: "anthropic/claude-opus-5-5",
      models: {
        "anthropic/claude-opus-5-5": {
          agentRuntime: { id: "claude-cli" },
        },
      },
    },
  },
}
```

Credentials remain in OpenClaw auth profiles or the owning plugin's config.
Command, argv, environment, parsing, session, image, and watchdog mechanics are
plugin code registered with `api.registerCliBackend(...)`.

## How it works

1. Selects the backend from the model's runtime policy (`agentRuntime.id`), or from the provider prefix of a standalone backend's model ref (`acme-cli/...`).
2. Builds a system prompt using the same OpenClaw prompt and workspace context.
3. Executes the CLI with a session id (if supported) so history stays consistent. The bundled `claude-cli` backend communicates directly with the installed Claude Code executable and keeps its authenticated subprocess warm across compatible agent turns.
4. Parses output (JSON or plain text) and returns the final text.
5. Persists session ids per backend so follow-ups reuse the same CLI session.

Claude stream-json backends also emit live line-count progress while `write`,
`edit`, and `apply_patch` arguments stream. Progress contains only the tool id,
name, and added/removed line counts, with at most four updates per second per
call. The execution-start event still waits for complete arguments; input
progress does not mean the tool has begun executing. If input generation is
interrupted, a later text block does not mark the abandoned tool as started.

Direct agent calls and child-completion updates share the same session reply policy.
A completion turn's delivery override does not by itself start a fresh CLI session;
authentication, workspace, and tool compatibility checks still apply.
Each turn receives delivery instructions for its current mode and available tools,
while the stored user message and reusable system prompt remain unchanged.

Existing sessions that stored the implicit automatic policy also retain continuity.
OpenClaw records the current policy when the next turn completes.

## Timeouts and long-running work

CLI backends have two independent limits:

- `agents.defaults.timeoutSeconds` limits the whole agent turn. Normal Gateway turns inherit the 48-hour default. `0` makes the turn budget unlimited. A stored override such as `600` replaces that default.
- The CLI no-output watchdog stops a subprocess that remains silent. Each backend plugin owns separate fresh/resume profiles, and the watchdog remains active even when the overall turn budget is unlimited.

Remove a short overall-timeout override to return to the 48-hour default, or set an explicit budget such as 12 hours:

```bash
# Return to the 48-hour default:
openclaw config unset agents.defaults.timeoutSeconds

# Or choose an explicit 12-hour limit:
openclaw config set agents.defaults.timeoutSeconds 43200
```

Background work started inside a CLI is still part of that CLI subprocess. If the parent turn reaches its overall limit, OpenClaw stops the subprocess and its CLI-internal background tasks together. For durable long work, use a detached OpenClaw [sub-agent](/tools/subagents) or [ACP agent](/tools/acp-agents). Detached sub-agents have no run timeout by default.

Local Claude CLI turns with bundled Gateway MCP use OpenClaw's `exec` and `process`
for shell work. Native `Bash` is disabled for those turns. A command still running
after the default 10-second yield window returns a managed process handle instead
of holding the tool call until it finishes. When completion notifications are
enabled, the result wakes the originating conversation; a busy conversation handles
it after its current turn. The continuation retains the originating turn’s tool
policy, including native and other MCP tools, subject to current session policy.
Restricted turns keep their original limits. If only waiting remains, the agent
reports that the job is running and ends its turn instead of repeatedly polling. Exec policy, configured
yield windows, command deadlines, and explicit notification settings still apply.

Exact tool selections, tool-free side questions, standalone CLI runs without
Gateway MCP, and paired-node Claude runs keep their existing tool contracts.
Plugin tools such as remote SSH do not become background jobs automatically.

When Claude Code moves a foreground Bash command to the background after its tool timeout,
OpenClaw keeps the turn active until Claude processes the completion and returns its final answer.
Follow-up tools still require the current turn's host permissions. Commands started explicitly
in the background do not hold the turn open. If the turn fails or is cancelled while one of these
commands still needs a follow-up, OpenClaw closes that subprocess and starts a fresh one for the next turn.

While native background agents or workflows continue, a completed Claude answer can reach the
channel through the normal reply pipeline without waiting for the continuation to finish.
This also works with raw previews and block streaming disabled. Already delivered answer segments
are not sent again at final settlement; failed deliveries remain eligible for retry. Delivering
an answer does not end the admitted turn or grant its background work another turn's permissions.

The `openclaw agent` command also has its own request deadline. Its 600-second fallback default applies to that command invocation, not to ordinary Gateway turns. See [`openclaw agent`](/cli/agent).

### Claude CLI specifics

Interrupted turns can retain ordinary partial prose. If an unfinished reply contains
standalone tool-protocol markup outside a code example, OpenClaw discards that
partial reply instead of saving it in conversation history. Completed replies keep
their existing validation, including support for discussing incomplete markup.
Stopping a turn does not let the Gateway save a buffered copy of a partial reply
that the CLI runner rejected.

The bundled Anthropic plugin communicates directly with the installed Claude Code
executable over its structured stdio protocol. Claude Code owns its existing local login and
subscription. OpenClaw uses a non-secret route marker. It never reads, persists,
refreshes, or forwards native tokens, or sends synthesized Anthropic API
requests. Compatible agent turns share one warm Claude Code subprocess.
A changed model, system prompt, or tool policy starts a
new subprocess. Persisted Claude session IDs still provide
conversation continuity when the Gateway or subprocess restarts.

For local plugin-managed turns, prompt-build hook context stays private: Claude
receives it as a native hook attachment, while OpenClaw history preserves the original user message. The
native session retains the context for resume. Imported visible history and
cross-provider fallback preludes do not copy private hook attachments.

Local plugin-managed Claude turns also receive the renderer-owned Runtime facts
through this private hook context on every turn. Session identity stays out of the
appended system prompt, so otherwise identical conversations can share its stable
prefix. Policy and workspace instructions remain in the system prompt; process
and paired-node transports keep their existing Runtime delivery.

Saved session notes also reach fresh and resumed turns as quoted reference data.
OpenClaw replays eligible notes from the active reset/compaction window, with a
total limit of 2,000 weighted characters including framing. Newer notes take
priority. Omitted or truncated notes are marked. Notes may repeat because CLI
bindings do not track which OpenClaw notes the native session has consumed.
Transient runtime context and notes excluded from model context are not replayed.

Claude Code registers OpenClaw MCP tools as `mcp__openclaw__<name>` and can
defer them behind ToolSearch. The Claude CLI backend explains this mapping in
the system prompt only when OpenClaw MCP tools are exposed to the invocation.
Message delivery guidance is included only when `message` is exposed: it uses `mcp__openclaw__message`, and a deferred tool
can be loaded with `select:mcp__openclaw__<name>`. This helps fresh sessions
discover the delivery tool when a conversation requires message-tool-only replies.

Keep Claude Code updated, especially if OpenClaw reports an incompatible
installed executable:

```bash
claude --version
claude update
# Restart the OpenClaw Gateway after updating.
```

The bundled `claude-cli` backend prefers Claude Code's native skill resolver. When the current skills snapshot has at least one selected skill with a materialized path, OpenClaw passes a temporary Claude Code plugin via `--plugin-dir`. It then omits the duplicate OpenClaw skills catalog from the appended system prompt. Without a materialized plugin skill, OpenClaw keeps the prompt catalog as a fallback. Skill env/API key overrides still apply to the child process environment for the run.

OpenClaw disables Claude Code's built-in Git workflow instructions and startup
Git-status snapshot with `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1`. Claude Code
rebuilds that snapshot when a process resumes, so workspace edits or commits
would otherwise invalidate cached conversation history. Git tools and workspace
instructions remain available. This does not prevent cache misses after prompt
changes, compaction, model or thinking changes, or cache expiry.

OpenClaw disables Claude Code's saved system-prompt snapshots so resumed turns
receive the current appended instructions, including per-turn plugin context.
Unchanged prompts keep the warm process and stable prefix; changed prompts restart
the process and resume the same conversation without rewriting its history.
Changing prompt bytes can invalidate the cached prefix where they change.

OpenClaw always launches Claude Code with its default permission mode.
OpenClaw's permission responses and `PreToolUse` hook keep native tools under
host control, including when user or enterprise settings would otherwise
preapprove a call. Native requests pass through canonical `before_tool_call`
policy before exec policy and approval, with native tool names and file
arguments projected into their OpenClaw equivalents. Per-agent and session
restrictions still override broader global policy. OpenClaw-owned MCP tools
remain authorized by the Gateway rather than receiving duplicate native
approval. Other MCP tools stay host-permission controlled.

Claude's native `AskUserQuestion` uses OpenClaw's structured question flow. When
OpenClaw rejects malformed questions, it reports the failed field and
constraint without repeating the submitted text, and asks Claude to correct
the field and retry. Invalid questions do not prompt the user. If the user
skips a valid question, Claude instead continues with its best judgment.

When the effective exec ask setting is `on-miss` or `always`, OpenClaw relays
native or extension tool requests that need approval to the session's
channel: **Allow once** permits the single call, **Allow always** permits that
tool name for the same warm live session while each subsequent turn's policy
and available tools still allow it, and **Deny**, a timeout, an unreachable
approval route, or a closed turn all deny the call. Grants stay in memory, end
when that exact live session is replaced, and never apply to Bash. Policies
that never prompt keep their existing behavior: `security: "deny"` rejects
every request, and ask `off` with less than full security denies without asking.

### Native Bash and the exec allowlist

When a run retains native `Bash`, `ask: "on-miss"` makes the `claude-cli` backend check commands
against the agent's [exec allowlist](/tools/exec-approvals). For example:

```bash
openclaw approvals allowlist add --agent main /usr/local/bin/gog
```

OpenClaw reuses its exec shell evaluator and allows a call without prompting
only when every command segment resolves to an explicitly allowlisted binary
and can be fully classified and bound. Executables may be absolute paths or
resolved through the CLI launch PATH with the agent's configured exec PATH
prepends. Approved input pins the
resolved executable paths. Successful matches update allowlist usage metadata.
Bindable misses prompt with the first unmatched segment or classification
reason. Commands the approval binding guard cannot bind, including pipelines,
command substitutions, subshells, write redirections, and unparsable syntax,
remain denied before a prompt. Environment-prefix overrides, shell expansions,
and `eval`/`exec`/`source` wrappers do not auto-allow.

`ask: "always"` still prompts for allowlisted commands. `security: "deny"`
still denies, and `ask: "off"` keeps the behavior described above. **Allow
always** remains unavailable for Bash, and truncated Bash approval descriptions
still fail closed.

This is argument-level policy applied to the command Claude Code will run,
not sandboxed execution by OpenClaw. Claude Code owns cwd, PATH, environment,
and sandboxing. Use a [paired node](/nodes) or the embedded runtime with
[sandboxing](/gateway/sandboxing) when sandboxed execution is required.

### Claude browser tools and 1Password sign-in

Claude Code can drive a Chrome browser through the [Claude in Chrome extension](https://code.claude.com/docs/en/chrome), including [1Password for Claude](/gateway/1password#browser-sign-in-with-1password-for-claude) credential autofill. The bundled backend does not enable it. Register a [CLI backend plugin](/plugins/cli-backend-plugins) that appends `--chrome` to the launch args of a `claude-stream-json`-dialect backend. OpenClaw preserves a configured `--chrome` on normal runs and always forces `--no-chrome` on runs with a restricted tool policy, such as side questions. The Chrome window, the extension, and any 1Password approval prompts live on the Gateway host. Someone must be at that machine to approve credential use.

The backend maps OpenClaw `/think` levels to Claude Code's native `--effort` flag: `minimal`/`low` -> `low`, `medium` -> `medium`, and `high`/`xhigh`/`max` pass through directly. For models that allow fixed thinking budgets, it also launches Claude Code with `MAX_THINKING_TOKENS`: `off=0`, `minimal=1024`, `low=2048`, `medium=8192`, `high`/`xhigh=16384`, and `max=32768`. Positive fixed budgets disable adaptive thinking. Models that require adaptive thinking omit the fixed budget and continue to use `--effort`. `adaptive` removes configured effort flags and fixed-budget environment overrides, so Claude Code resolves effective thinking from its own environment, settings, and model defaults. Other CLI backends need their owning plugin to map the selected level before `/think` affects the spawned CLI.

For native login, sign in to Claude Code on the Gateway host:

```bash
claude auth login
claude auth status --text
openclaw models auth login --provider anthropic --method cli --set-default
```

Normal agent turns can also use a saved subscription token without a native login:

```bash
openclaw models auth paste-token --provider anthropic
```

New sessions select saved subscription credentials through the configured account
order and forward them to the CLI through a protected file descriptor. Existing
sessions keep their account until you select another or remove its saved profile.
Explicit account selections and empty account orders remain authoritative. API keys saved
for the `anthropic` provider require an explicit selection; they do not replace
native subscription login automatically.

Fresh plugin completions, including Memory Dreaming, use the same account order.
An explicit profile on the requested model stays authoritative; an empty account
order preserves native Claude login.

Docker installs need Claude Code and the chosen credentials inside the persisted container home, not only on the host. See [Claude CLI backend in Docker](/install/docker#claude-cli-backend-in-docker).

The gateway service must resolve `claude` on `PATH`. For a nonstandard path,
register a small wrapper backend plugin.

## Sessions

- If the CLI supports sessions, set `sessionArgs` with a `{sessionId}` placeholder (for example `["--session-id", "{sessionId}"]`).
- If the CLI uses a resume subcommand with different flags, set `resumeArgs` (replaces `args` when resuming) and optionally `resumeOutput` for non-JSON resumes.
- `sessionMode`:
  - `always`: always send a session id (new UUID if none stored).
  - `existing`: only send a session id if one was stored before.
  - `none`: never send a session id.
- `claude-cli` defaults to `liveSession: "claude-stdio"`, `output: "jsonl"`, and `input: "stdin"`. The owning Anthropic plugin keeps one Claude Code subprocess warm for compatible consecutive agent turns through its direct CLI transport. If the Gateway restarts or the idle process exits, OpenClaw resumes from the stored Claude session id. Stored session ids are verified against a readable project transcript before resume. A missing transcript clears the binding (logged as `reason=transcript-missing`) instead of silently starting a fresh session under `--resume`.
- Forking a session (Control UI "Fork conversation", `sessions.create` with `fork: true`, `sessions_spawn` with `context: "fork"`) branches the stored CLI session with the transcript. The child's first turn resumes the parent's native session with the backend's fork flag (`--fork-session` for `claude-cli`), pinned to the parent's last recorded checkpoint, then keeps the new native id. The copied binding is validated like any other before it is resumed, so a changed auth profile or environment starts the child fresh instead. The parent's binding is unchanged. Backends without fork and checkpoint-resume support, or bindings without a recorded checkpoint, start a fresh native session in the child. Per-message forks from the chat pane start a fresh CLI session because they cut the transcript at an earlier point.
- Stopping or timing out a resumed turn preserves its existing native session, including when it already sent a progress message through a Gateway tool. The next turn can resume that history without replaying the interrupted request. A provider-reported expired session or an aborted fork replacement still clears the binding; normal account, workspace, and tool compatibility checks still apply.
- Stored CLI sessions are provider-owned continuity. Automatic reset is disabled by default. `/reset` and explicit daily or idle `session.reset` policies still cut them.
- Fresh CLI sessions can recover OpenClaw history from the canonical session SQLite database when its independent account boundary matches the selected credential. Compacted recovery includes the latest summary, retained messages, and subsequent turns on the active branch. A backend can opt in to bounded recovery before compaction with `reseedFromRawTranscriptWhenUncompacted: true`, including after its native session binding is cleared. Recovery includes saved tool-result text and error markers. It does not execute past tools. The current user turn is sent once, outside the recovered history.
- Helper runs with a caller-owned in-memory transcript use that history for hooks, bounded session notes, and fresh-session reseeding, including meaningful history before compaction. Empty memory stays empty even when the run carries another session's storage identity. Context-engine maintenance rewrites that same memory before the helper returns, even when the engine requests background maintenance. Durable transcripts retain their background maintenance path. An explicitly owned native CLI binding can still resume. Resumed turns send the current prompt and bounded session notes without replaying the conversation history.

Warm processes belong to the conversation, including when turns alternate between a channel and `chat.send`. A different inbound account or auth profile retires the previous process and waits for cleanup before starting its replacement. Account-private standing approvals do not carry into the replacement.

When prompt content changes, a compatible CLI session can resume with an OpenClaw
context note before the current user prompt. Chat history first matches imported
Claude user turns against the full local text, including any literal quote of the
note. If that does not match, it ignores one exact context note for comparison, so
the same turn appears once. Queued system events, including model-switch notices,
are ignored for matching even after generated conversation metadata and recent
chat history. Stored OpenClaw and native transcript text remains unchanged.
For unmatched imported user turns, chat history removes generated
resume notes, historical requester guidance, and queued system-event prefixes
from the display copy only. Historical requester guidance is recognized by its
complete generated prefix; matching canonical user text and later quoted
guidance remain unchanged.
Recognized runtime prompts, such as default heartbeat, exec-completion, restart
recovery, and native compaction prompts, are hidden rather than shown as human
messages. Matching canonical user turns and quoted text in later content blocks
remain unchanged. Native and OpenClaw history share bounded pages and
message-anchor lookups. The history worker prepares a temporary merged index
without modifying the canonical transcript. A cold index scans bounded source pages to preserve
global deduplication; subsequent reads select only their requested window. The
index is discarded when either transcript changes or its database owner closes.
Reset-archive fallbacks rebuild the index per request because their source files
have a separate revision from the active database.
Incognito history uses a request-scoped memory index and never writes that index
to disk. No migration or update repair is required.

### History account boundaries

Native session compatibility and permission to replay saved OpenClaw history are separate. Clearing or replacing a native binding does not establish ownership of older transcript rows. OpenClaw records a private account fingerprint and contiguous transcript coverage before an admitted CLI turn, then advances coverage with that turn’s canonical writes. It never stores credential values in this metadata.

Automatic durable recovery requires a resolved static credential or a named OAuth account. Opaque CLI logins, identity-less OAuth credentials, legacy transcripts without provenance, imported or otherwise unaccounted content, and incompatible provenance versions cannot authorize automatic replay. Native resume remains available under the backend’s existing rules. Switching accounts makes mixed history ineligible even after a successful replacement, a later clear, or a switch back to the original account. A new session or an empty reset can establish a new boundary. A reset that retains messages cannot relabel them.

This uses existing session metadata and transcript generation/sequence counters. No SQLite schema migration or transcript deletion occurs. Existing conversations are not backfilled from their latest native binding. Older binaries do not enforce this new recovery boundary. After a downgrade and subsequent transcript writes, upgrading again refuses automatic replay because those writes are not covered. Do not rely on a downgrade to preserve the new security behavior.

Explicit caller-owned in-memory context remains caller-supplied input, not permission to read a durable conversation carrying the same identifiers. Authentication invalidations still refuse its recovery prompt and saved session notes. When automatic recovery is refused, the saved transcript remains intact. The next CLI process receives the current request without the saved history or notes.

An admitted resume of the same native Claude session can still receive the count, time range, and models of intervening messages, plus a `sessions_history` call for the current chat when that tool is available. A fresh native Claude session after an authentication-profile, epoch, or unknown-identity boundary can receive the same metadata about earlier recorded messages in its existing OpenClaw chat. This notice contains no transcript text or saved notes and does not authorize automatic replay; reading history remains an on-demand tool action subject to the current tool policy.

The notice prefixes only that native user turn. OpenClaw keeps the original user text; native-history imports correlate the prefixed turn with its existing local row instead of adding a duplicate.

Serialization: `serialize: true` keeps same-lane runs ordered (most CLIs serialize on one provider lane). OpenClaw also drops stored CLI session reuse when the selected auth identity changes. A changed auth profile id, static API key, static token, or OAuth account identity all count, when the CLI exposes one. OAuth access and refresh token rotation alone does not cut the session. If a CLI has no stable OAuth account id, OpenClaw lets that CLI enforce its own resume permissions.

## Fallback prelude from claude-cli sessions

A `claude-cli` attempt can fail over to a non-CLI candidate in [`agents.defaults.model.fallbacks`](/concepts/model-failover). OpenClaw then seeds the next attempt with a context prelude harvested from Claude Code's local JSONL transcript. That transcript lives under `~/.claude/projects/`, keyed per workspace. This supplies CLI-owned context that may not be present in OpenClaw's SQLite session transcript.

- The prelude prefers the latest `/compact` summary or `compact_boundary` marker, then appends the most recent post-boundary turns up to a char budget. Pre-boundary turns are dropped because the summary already represents them.
- Tool blocks are coalesced to compact `(tool call: name)` and `(tool result: …)` hints to keep the prompt budget honest. An oversized summary is truncated and labeled `(truncated)`.
- Same-provider `claude-cli` to `claude-cli` fallbacks rely on Claude's own `--resume` and skip the prelude.
- The seed reuses the existing Claude session-file path validation, so arbitrary paths cannot be read.

## Images

Plugin authors declare image-path support with `imageArg`:

```json5
imageArg: "--image",
imageMode: "repeat"
```

OpenClaw writes base64 images to temp files. If `imageArg` is set, those paths are passed as CLI args. If not, OpenClaw appends the file paths to the prompt (path injection), which works for CLIs that auto-load local files from plain paths.

## Inputs and outputs

- `output: "text"` (default) treats stdout as the final response.
- `output: "json"` tries to parse JSON and extract text plus a session id.
- `output: "jsonl"` parses a JSONL stream and extracts the final agent message plus session identifiers when present.
- For Gemini CLI JSON output, OpenClaw reads reply text from `response` and usage from `stats` when `usage` is missing or empty. The bundled Gemini CLI adapter uses `stream-json`.

JSON examples inside double-quoted banner text are not treated as response or error records.
For JSONL, banner scanning starts fresh on each line.

Claude streaming limits discount recognized partial-message envelopes while
counting their text, thinking, and tool-input payloads. Cumulative snapshots and
tool results still count toward the output budget. Single-line limits and bounded
frame counts remain active, including for empty or unrecognized events.

Input modes:

- `input: "arg"` (default) passes the prompt as the last CLI arg.
- `input: "stdin"` sends the prompt via stdin.
- If the prompt is very long and `maxPromptArgChars` is set, stdin is used instead.

## Plugin-owned defaults

CLI backend defaults are part of the plugin surface:

- Plugins register them with `api.registerCliBackend(...)`.
- The backend `id` becomes the provider prefix in model refs.
- Command, argv, environment, parser, session, and watchdog behavior stays in plugin code.
- Backend-specific normalization stays plugin-owned through the optional `normalizeConfig` hook.

Anthropic owns `claude-cli` and Google owns `google-gemini-cli`. OpenAI Codex agent runs use the Codex app-server harness through `openai/*`. There is no bundled `codex-cli` backend.

The bundled Anthropic plugin registers for `claude-cli`:

| Key                   | Value                                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`             | `claude`                                                                                                                                                                                                      |
| `args`                | `-p --output-format stream-json --include-partial-messages --verbose --setting-sources user --allowedTools mcp__openclaw__* --disallowedTools ScheduleWakeup,CronCreate,Bash(run_in_background:true),Monitor` |
| `output`              | `jsonl`                                                                                                                                                                                                       |
| `input`               | `stdin`                                                                                                                                                                                                       |
| `modelArg`            | `--model`                                                                                                                                                                                                     |
| `sessionArgs`         | `["--session-id", "{sessionId}"]`                                                                                                                                                                             |
| `sessionMode`         | `always`                                                                                                                                                                                                      |
| agent runtime         | Direct stdio transport to a warm, session-scoped Claude Code subprocess                                                                                                                                       |
| `imageArg`            | `@`                                                                                                                                                                                                           |
| `imagePathScope`      | `workspace`                                                                                                                                                                                                   |
| `systemPromptFileArg` | `--append-system-prompt-file`                                                                                                                                                                                 |
| `systemPromptMode`    | `append`                                                                                                                                                                                                      |

On Claude Code 2.1.98 or newer, the bundled backend adds
`--exclude-dynamic-system-prompt-sections` after a bounded version check on the
first CLI execution. Concurrent executions share the check. API catalog discovery
does not start it. Older, unknown, or failed checks keep the established argv.

The bundled Google plugin registers for `google-gemini-cli`:

| Key                       | Value                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `command`                 | `gemini`                                                                               |
| `args`                    | `--skip-trust --approval-mode auto_edit --output-format stream-json --prompt {prompt}` |
| `resumeArgs`              | same, with `--resume {sessionId}`                                                      |
| `output` / `resumeOutput` | `jsonl`                                                                                |
| `jsonlDialect`            | `gemini-stream-json`                                                                   |
| `imageArg`                | `@`                                                                                    |
| `imagePathScope`          | `workspace`                                                                            |
| `modelArg`                | `--model`                                                                              |
| `sessionMode`             | `existing`                                                                             |
| `sessionIdFields`         | `["session_id", "sessionId"]`                                                          |

Prerequisites: the local Gemini CLI must be installed and on `PATH` as `gemini`
(`brew install gemini-cli` or `npm install -g @google/gemini-cli`), and the
selected model must have a supported Google AI Studio API-key profile. Existing
valid legacy Gemini CLI OAuth profiles remain runtime-compatible, but OpenClaw
does not create or repair them.

Gemini CLI output notes:

- The default `stream-json` parser reads assistant `message` events, tool events, final `result` usage, and fatal Gemini error events.
- Usage falls back to `stats` when `usage` is absent or empty. `stats.cached` normalizes into OpenClaw `cacheRead`, and if `stats.input` is missing, input tokens derive from `stats.input_tokens - stats.cached`.

## Text transform overlays

Plugins that need small prompt/message compatibility shims can declare bidirectional text transforms without replacing a provider or CLI backend:

```typescript
api.registerTextTransforms({
  input: [{ from: /red basket/g, to: "blue basket" }],
  output: [{ from: /blue basket/g, to: "red basket" }],
});
```

`input` rewrites the system prompt and user prompt passed to the CLI. `output` rewrites streamed assistant text and parsed final text before OpenClaw handles its own control markers and channel delivery. For provider-backed model calls it also restores string values inside structured tool-call arguments after stream repair and before tool execution. Raw provider JSON fragments are left unchanged. Consumers should use the structured partial, end, or result payload.

For CLIs that emit provider-specific JSONL events, set `jsonlDialect` on that backend's config: `claude-stream-json` for Claude Code-compatible streams, `gemini-stream-json` for Gemini CLI `stream-json` events. Declaring `claude-stream-json` is a contract: the backend's `result` records carry Claude Code's terminal semantics, including `terminal_reason`. A reply-less `result` can carry a `terminal_reason` saying the CLI ended the turn on purpose after work may have run. Those reasons are `hook_stopped`, `stop_hook_prevented`, `aborted_tools`, `aborted_streaming`, `budget_exhausted`, and `max_turns`. OpenClaw treats that as a recorded turn stop. It reports the reason to the user and does not replay the turn on a fallback model, because the backend's tool actions may already have run.

## Native compaction ownership

Some CLI backends run an agent that compacts its own transcript. OpenClaw must not run its safeguard summarizer against them. Doing so fights the backend's own compaction and can hard-fail the turn.

`claude-cli` has no harness endpoint (Claude Code compacts internally), so it declares `ownsNativeCompaction: true`. Automatic OpenClaw compaction defers to Claude Code, while an explicit `/compact` resumes the bound Claude Code session and sends its native `/compact` command. OpenClaw passes the run's effective context budget through Claude Code's documented [`CLAUDE_CODE_AUTO_COMPACT_WINDOW`](https://code.claude.com/docs/en/env-vars), keeping native auto-compaction aligned with configured Anthropic `contextTokens` limits. Native-harness sessions such as Codex keep routing to their harness compaction endpoint instead.

`google-gemini-cli` also owns automatic compaction and persists its compressed session for resume. OpenClaw defers to Gemini CLI rather than running a second summarizer. Explicit `/compact` is unsupported for this backend because it does not declare a manual compaction capability.

```typescript
api.registerCliBackend({
  id: "my-cli",
  ownsNativeCompaction: true,
  manualCompaction: {
    buildPrompt: (instructions) => (instructions ? `/compact ${instructions}` : "/compact"),
    input: "arg",
    validateOutput: (rawOutput) =>
      rawOutput.includes('"type":"compaction_complete"')
        ? { ok: true }
        : { ok: false, reason: "CLI did not confirm compaction." },
  },
  // ...
});
```

Only declare `ownsNativeCompaction` for a backend that genuinely owns compaction. It must reliably bound its own transcript near the context window, and persist a resumable session such as `--resume` or `--session-id`. Otherwise a deferred session can stay over budget.

Add the atomic `manualCompaction` capability only when its command compacts the resumed session in place. Its `input` selects the transport the backend command actually recognizes, and `validateOutput` must require a positive backend acknowledgement rather than treating a zero exit as success. OpenClaw runs it as an internal control operation: it is not written as a user turn and does not run agent or context-engine turn hooks.

## Bundle MCP overlays

CLI backends do not receive OpenClaw tool calls directly, but a backend can opt into a generated MCP config overlay with `bundleMcp: true`. Current bundled behavior:

- `claude-cli`: generated strict MCP config file.
- `google-gemini-cli`: generated Gemini system settings file.

When bundle MCP is enabled, OpenClaw:

- spawns a loopback HTTP MCP server that exposes Gateway tools to the CLI process, authenticated with a per-run context grant (`OPENCLAW_MCP_TOKEN`) active only for the current execution attempt
- binds tool access to the Gateway-selected session, account, and channel context instead of trusting child-process headers
- loads enabled bundle-MCP servers for the current workspace and merges them with any existing backend MCP config or settings shape
- rewrites the launch config using the backend-owned integration mode from the owning plugin.

The loopback bridge sends keepalive bytes while a tool response or notification
stream is idle, so HTTP idle timeouts do not interrupt long-running tools. These
bytes are not tool results or agent progress; client request deadlines and the
current model attempt's timeout still apply.

The shared listener remains available after the turn that first started it completes.
Later calls use their own run's permissions and caller liveness, without retaining
the starting turn's transcript read fence or request scope.
The listener retains the Gateway's process broker and database-reader lifecycle.
After plugin replacement, new CLI turns resolve bridge tools against the current
plugin generation without restarting the listener. Retired plugin instances remain
unavailable, and each turn still needs its own active context grant.

With the Gateway's MCP bridge, channel-origin CLI turns can use the `message`
tool for permitted reads and same-conversation actions, including reactions. The
bridge retains the admitted sender, account, and conversation; channel access and
write permissions still apply. That authority ends with the turn or its
cancellation, including when a warm CLI process is reused for a later turn.

Automations created through the bridge without a finite `toolsAllow` list follow the
owner session's tool policy at run time. A finite list is capped to the bridge's final
permitted tools and supported native capabilities. When a run retains native `Bash` for `exec`,
the saved automation retains its Gateway host target, including with an explicit
`toolsAllow: ["exec"]` cap. Current account, tool, sandbox, and approval restrictions
still apply; capturing the target does not grant broader execution permission.

Backends that retain their native shell can also receive a node-only `exec` tool,
offered only when policy permits it and a connected
node advertises `system.run`. Offline paired devices and approval-only phones do
not make remote execution available. A configured node binding must identify an
eligible node. It never redirects to another device. When several eligible nodes
are connected, select one explicitly. When local execution is allowed by policy,
use managed `exec` for local Claude MCP turns, or the native shell when the backend
retains it.

`tools.allow` and `tools.deny` also constrain configured native MCP servers.
OpenClaw lists each server through its session-scoped runtime, assigns the same
provider-safe `<safe-server>__<safe-tool>` identities used by embedded tools,
and applies the complete layered policy before process spawn or Codex
`thread/start`/`thread/resume`. It then projects exact raw names into each
backend's enforcement contract: Claude receives server omission plus bare
`--disallowedTools` entries, Codex receives `enabled_tools` and
`disabled_tools`, and Gemini receives `includeTools` and `excludeTools`.
Configured server filters and session overrides remain additional
restrictions. These backend fields are generated implementation details. Keep
operator policy in OpenClaw configuration.

For example, `agents.entries.research.tools.allow: ["docs__read_docs"]`
exposes only that tool from the safe `docs` namespace, while
`deny: ["docs__delete_*"]` removes matching siblings. An empty intersection
omits the affected MCP server. A server whose restrictive catalog cannot be
established is also omitted and reported instead of being passed through
unfiltered.

Restricted runs such as cron jobs with `toolsAllow` require an exact
backend-owned translation. The bundled `claude-cli` backend disables Claude's
native tools and user, project, and local customizations, including hooks,
plugins, agents, skills, and `CLAUDE.md`. It then exposes every allowed
OpenClaw tool through the grant-scoped MCP server. This keeps filesystem,
process, exec, approval, and sandbox policy inside OpenClaw instead of widening
authority to Claude's native tools or customization processes. The same MCP
list is enforced in Claude's generated config and again by the Gateway on tool
listing and execution. Before minting the grant, core rejects backend
translations that name any MCP permission outside the original allowlist.
Backends without an exact translation still fail closed.

If no MCP servers are enabled, OpenClaw still injects a strict config when a backend opts into bundle MCP, so background runs stay isolated.

Session-scoped bundled MCP runtimes are cached for reuse within a session, then reaped after 10 minutes of idle time. One-shot embedded runs such as auth checks, slug generation, and active-memory recall request cleanup at run end. Stdio children and Streamable HTTP or SSE streams therefore do not outlive the run.

A fresh CLI session must wait for its predecessor's cleanup. If cleanup fails or
exceeds its deadline, OpenClaw refuses replacement, including from a later run.
Check the cleanup error and the backend's remaining processes before retrying.
Command output and process exit alone do not confirm that descendants stopped.

For `claude-cli`, the installed Claude Code process uses its current native
login. OpenClaw uses a non-secret route marker and never reads, persists,
refreshes, selects, or forwards the native tokens.
Set `CLAUDE_CONFIG_DIR` on the Gateway process to use a separate Claude configuration directory.
Explicit OpenClaw-managed API-key and token profiles continue to use the
protected, per-invocation credential-forwarding CLI path.

## Reseed history cap

A fresh CLI session can be seeded from a prior OpenClaw transcript, for example after a `session_expired` retry. The rendered `<conversation_history>` block is then capped to keep reseed prompts from growing without bound. The default is 12,288 characters (about 3,000 tokens).

Claude CLI backends scale this cap with the resolved Claude context window instead. A larger context window gets a larger prior-history slice, up to a fixed ceiling. Other CLI backends keep the conservative default. This cap only governs the reseed prompt's prior-history block.

## Limitations

- OpenClaw does not inject tool calls into the CLI backend protocol. Backends only see Gateway tools when they opt into `bundleMcp: true`.
- Streaming is backend-specific: some backends stream JSONL, others buffer until exit.
- Structured outputs depend on the CLI's own JSON format.

## Troubleshooting

When a local Claude Code subprocess fails, its run error includes a bounded,
redacted stderr diagnostic when available. Check the run error or `openclaw logs`
for the underlying launch, permission, or runtime failure. Successful turns do not
forward stderr into logs. Each live process has its own diagnostic buffer. Since
stderr has no turn identifiers, a warm process's failure can include earlier turns.
The error labels that output as process-wide rather than attributing it to the failing turn.
Oversized incomplete lines are omitted so truncation cannot expose credential
fragments. Native stdout and MCP input are not included in these diagnostics.
Stderr is supplemental display text only. It does not change the native error's
retry, authentication, timeout, or fallback classification.

On macOS and Linux, a broken input pipe preserves the process's exit error when
the child exits during graceful shutdown. If OpenClaw must terminate the child,
the original pipe error remains the failure; cancellation retains its own reason.

| Symptom               | Fix                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| CLI not found         | Put the CLI on the Gateway service's `PATH`, or update the owning plugin's registered command. |
| Wrong model name      | Update the plugin's `modelAliases` mapping.                                                    |
| No session continuity | Check the plugin's `sessionArgs` and `sessionMode`.                                            |
| Images ignored        | Check the plugin's `imageArg` and the CLI's file-path support.                                 |

## Related

- [Gateway runbook](/gateway)
- [Local models](/gateway/local-models)
- [Thinking levels](/tools/thinking) — how the reasoning budget maps onto a CLI backend
