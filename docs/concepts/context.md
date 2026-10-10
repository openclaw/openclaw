---
summary: "Context: what the model sees, how it is built, and how to inspect it"
read_when:
  - You want to understand what "context" means in OpenClaw
  - You are debugging why the model "knows" something (or forgot it)
  - You want to reduce context overhead (/context, /status, /compact)
title: "Context"
---

"Context" is **everything OpenClaw sends to the model for a run**. It is bounded by the model's **context window** (token limit).

Beginner mental model:

- **System prompt** (OpenClaw-built): rules, tools, skills list, time/runtime, and injected workspace files.
- **Conversation history**: your messages + the assistant's messages for this session.
- **Tool calls/results + attachments**: command output, file reads, images/audio, etc.

Context is _not the same thing_ as "memory": memory can be stored on disk and reloaded later; context is what's inside the model's current window.

## Quick start (inspect context)

- `/status` → quick "how full is my window?" view + session settings.
- `/context list` → what's injected + rough sizes (per file + totals).
- `/context detail` → deeper breakdown: per-file, per-tool schema sizes, per-skill entry sizes, system prompt size, and compactable transcript message counts.
- `/context map` → WinDirStat-style treemap image of the current session's tracked context contributors.
- `/usage tokens` → append per-reply usage footer to normal replies.
- `/compact` → summarize older history into a compact entry to free window space.

See also: [Slash commands](/tools/slash-commands), [Token use & costs](/reference/token-use), [Compaction](/concepts/compaction).

`/context` and `openclaw sessions list` can reuse the last verified model budget
when catalog metadata is unavailable and the selected model and runtime still
match. A qualifying turn refreshes this value. Current model metadata and
configured limits take precedence; generic fallback windows and removable caps
are not saved as verified model budgets.

The Control UI context meter uses the last run's prompt budget when it still
matches the selected model and effective context cap. This budget leaves room
for the runtime's compaction reserve. Its label is **Prompt budget (last run)**:
it is an estimate, and crossing it can trigger tool-result reduction or compaction.
After a model or context-cap change, the meter shows **Context window** until a
new run supplies a matching estimate. Stale token totals remain approximate and
do not trigger the context warning.

## Example output

Values vary by model, provider, tool policy, and what's in your workspace.

### `/context list`

```text
🧠 Context breakdown
Workspace: <workspaceDir>
Bootstrap max/file: 20,000 chars
Sandbox: mode=non-main sandboxed=false
System prompt (run): 38,412 chars (~9,603 tok) (Project Context 23,901 chars (~5,976 tok))

Injected workspace files:
- AGENTS.md: OK | raw 1,742 chars (~436 tok) | injected 1,742 chars (~436 tok)
- SOUL.md: OK | raw 912 chars (~228 tok) | injected 912 chars (~228 tok)
- IDENTITY.md: OK | raw 211 chars (~53 tok) | injected 211 chars (~53 tok)
- USER.md: OK | raw 388 chars (~97 tok) | injected 388 chars (~97 tok)
- BOOTSTRAP.md: OK | raw 0 chars (~0 tok) | injected 0 chars (~0 tok)

Skills list (system prompt text): 2,184 chars (~546 tok) (12 skills)
Tools: read, edit, write, exec, process, browser, message, sessions_send, …
Tool list (system prompt text): 1,032 chars (~258 tok)
Tool schemas (JSON): 31,988 chars (~7,997 tok) (counts toward context; not shown as text)
Tools: (same as above)

Session tokens (cached): 14,250 total / ctx=32,000
```

### `/context detail`

```text
🧠 Context breakdown (detailed)
…
Top skills (prompt entry size):
- frontend-design: 412 chars (~103 tok)
- oracle: 401 chars (~101 tok)
… (+10 more skills)

Top tools (schema size):
- browser: 9,812 chars (~2,453 tok)
- exec: 6,240 chars (~1,560 tok)
… (+N more tools)
```

### `/context map`

Sends an image generated from the latest cached run report plus the session transcript. Before a normal message has produced a run report in the session, `/context map` returns an unavailable message instead of rendering an estimate. Rectangle area is proportional to tracked prompt characters:

- conversation transcript (user messages, assistant replies, tool results, compaction summaries), plus per-turn runtime context and hook prompt additions that reach only the model
- injected workspace files
- base system prompt text
- skill prompt entries
- tool JSON schemas

The conversation group grows as the session does, so the map changes turn over turn; after compaction it collapses into a summaries tile.

`/context list`, `/context detail`, and `/context json` can still inspect an on-demand estimate when no run report is cached.

## What counts toward the context window

Everything the model receives counts, including:

- System prompt (all sections).
- Conversation history.
- Tool calls + tool results.
- Attachments/transcripts (images/audio/files).
- Compaction summaries and pruning artifacts.
- Provider "wrappers" or hidden headers (not visible, still counted).

## How OpenClaw builds the system prompt

The system prompt is **OpenClaw-owned** and rendered each run. It includes:

- Tool list + short descriptions.
- Skills list (metadata only; see below).
- Workspace location.
- Time (UTC + converted user time if configured).
- Runtime metadata (host/OS/model/thinking).
- Injected workspace bootstrap files under **Project Context**.

Full breakdown: [System Prompt](/concepts/system-prompt).

On supported direct Anthropic API-key routes and native OpenAI Responses routes,
OpenClaw pins the complete system prompt for the session. Changed sections,
including skills, workspace memory, and temporal context, arrive as instruction
messages after the current user turn. Existing skill and memory refresh rules
still apply. Changing the route or selected personal profile, resetting, or
compacting history starts a new series; ordinary turn teardown and Gateway restarts restore the saved series.

## Injected workspace files (Project Context)

By default, OpenClaw injects a fixed set of workspace files (if present):

- `AGENTS.md`
- `SOUL.md`
- `IDENTITY.md`
- `USER.md`
- `BOOTSTRAP.md` (first-run only)

Large files are truncated per-file using `agents.defaults.bootstrapMaxChars` (default `20000` chars). OpenClaw also enforces a total bootstrap injection cap across files with `agents.defaults.bootstrapTotalMaxChars` (default `60000` chars). `/context` shows **raw vs injected** sizes and whether truncation happened.

When truncation occurs, the runtime injects a concise in-prompt notice under Project Context saying some bootstrap files were truncated; per-file names and sizes stay in `/context` and other diagnostics. This notice is built in and not configurable.

## Skills: injected vs loaded on-demand

The system prompt includes a compact **skills list** (name + description + location). This list has real overhead.

`/context` counts the catalog included in the rendered system prompt, not every installed skill. In the embedded runtime without Code Mode, denying both `read` and `skills_read` omits the catalog and reports zero skills.

Skill instructions are _not_ included by default. The model is expected to `read` the skill's `SKILL.md` **only when needed**.

## Tools: there are two costs

Tools affect context in two ways:

1. **Tool list text** in the system prompt (what you see as "Tooling").
2. **Tool schemas** (JSON). These are sent to the model so it can call tools. They count toward context even though you don't see them as plain text.

`/context detail` breaks down the biggest tool schemas so you can see what dominates.

## Commands, directives, and "inline shortcuts"

Slash commands are handled by the Gateway. There are a few different behaviors:

- **Standalone commands**: a message that is only `/...` runs as a command.
- **Directives**: `/think`, `/fast`, `/verbose`, `/trace`, `/reasoning`, `/elevated`, `/exec`, `/model`, `/queue` are stripped before the model sees the message.
  - Directive-only messages persist session settings.
  - Inline directives in a normal message act as per-message hints.
- **Inline shortcuts** (allowlisted senders only): certain `/...` tokens inside a normal message can run immediately (example: "hey /status"), and are stripped before the model sees the remaining text.

Details: [Slash commands](/tools/slash-commands).

## Sessions, compaction, and pruning (what persists)

What persists across messages depends on the mechanism:

- **Normal history** persists in the session transcript until compacted/pruned by policy.
- **Compaction** persists a summary into the transcript and keeps recent messages intact.
- **Pruning** drops old tool results from the _in-memory_ prompt to free context-window space, but does not rewrite the session transcript - the full history is still inspectable on disk.

For embedded Responses requests, current request metadata stays after the user
message or compaction checkpoint and before its tool calls. This lets supported transports reuse the
previous response across tool rounds without dropping live context. A later user
turn in an OpenAI Responses-family session preserves hidden runtime-context
carriers append-only, so the previous turn, including tool calls and results,
remains an unchanged cached prefix. Retained carriers count toward the context
window until compaction, which does not split a user message from its carrier.
Carriers contain only the delimited context body; interpretation guidance lives
once in the stable system prompt.

Supported direct Anthropic API-key routes also preserve runtime context
append-only, using system messages after the user turn and its other queued
context. These messages need no delimiters and clear at the next user message:
they remain in the transcript but no longer consume input tokens. Persistent
system-prompt updates use the same system-message channel without clearing.
Tool results and queued extension context also clear earlier copies; OpenClaw
renews the current user turn's runtime context after those continuations.
Other prefix-binding Claude routes retain their delimited user-role carriers.
See [Anthropic retained thinking](/providers/anthropic#tool-calls-and-retained-thinking)
for supported models and route limits.

Transient carriers remain the cheaper shape on routes without this capability
when thinking does not bind the prefix. Those routes keep metadata at the
request tail and remove it on the next user turn, preserving the cached history
without retaining old context or repeated cache-read charges.

Docs: [Session](/concepts/session), [Compaction](/concepts/compaction), [Session pruning](/concepts/session-pruning).

By default, OpenClaw uses the built-in `legacy` context engine for assembly and
compaction. If you install a plugin that provides `kind: "context-engine"` and
select it with `plugins.slots.contextEngine`, OpenClaw delegates context
assembly, `/compact`, and related subagent context lifecycle hooks to that
engine instead. `ownsCompaction: false` does not auto-fallback to the legacy
engine; the active engine must still implement `compact()` correctly. See
[Context Engine](/concepts/context-engine) for the full
pluggable interface, lifecycle hooks, and configuration.

## What `/context` actually reports

`/context` prefers the latest **run-built** system prompt report when available:

- `System prompt (run)` = captured from the last embedded (tool-capable) run and persisted in the session store.
- `System prompt (estimate)` = computed on the fly when no run report exists (or when running via a CLI backend that doesn't generate the report).

Either way, it reports sizes and top contributors; it does **not** dump the full system prompt or tool schemas. In detailed mode, it also compares the session transcript with the same real-conversation message predicate used by compaction, so high prompt/cache usage is easier to distinguish from compactable conversation history.

## Related

<CardGroup cols={2}>
  <Card title="Context engine" href="/concepts/context-engine" icon="puzzle-piece">
    Custom context injection via plugins.
  </Card>
  <Card title="Compaction" href="/concepts/compaction" icon="compress">
    Summarizing long conversations to keep them inside the model window.
  </Card>
  <Card title="System prompt" href="/concepts/system-prompt" icon="message-lines">
    How the system prompt is built and what it injects each turn.
  </Card>
  <Card title="Agent loop" href="/concepts/agent-loop" icon="arrows-rotate">
    The full agent execution cycle from inbound message to final reply.
  </Card>
</CardGroup>
