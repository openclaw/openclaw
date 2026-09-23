---
summary: "The hooks shipped with OpenClaw and the behavior and options of each"
read_when:
  - You want to enable a hook without writing one
  - You need `boot-md`, `bootstrap-extra-files`, `command-logger`, `compaction-notifier`, or `session-memory` behavior
  - You are configuring a bundled hook's per-entry options
title: "Bundled hooks"
---

The hooks shipped with OpenClaw, and the behavior and options of each. Part of the [Hooks](/automation/hooks) guide.

## Bundled hooks

| Hook                    | Events                                               | Purpose                                                    |
| ----------------------- | ---------------------------------------------------- | ---------------------------------------------------------- |
| `boot-md`               | `gateway:startup`                                    | Run workspace `BOOT.md` instructions at startup.           |
| `bootstrap-extra-files` | `agent:bootstrap`                                    | Add matching workspace bootstrap files to context.         |
| `command-logger`        | `command`                                            | Append emitted command events to a JSONL log.              |
| `compaction-notifier`   | `session:compact:before`, `session:compact:after`    | Add compaction status notices on supported delivery paths. |
| `session-memory`        | `command:new`, `command:reset`, `session:auto-reset` | Save recent conversation excerpts to workspace memory.     |

Enable one with `openclaw hooks enable <hook-name>` and verify its side effect.
Startup-only hooks such as `boot-md` wait for the next Gateway start.

<a id="boot-md"></a>

### boot-md details

Runs a nonempty `BOOT.md` from each configured agent's resolved workspace.
Workspaces shared by multiple agents run only once, under the first agent
selected for that workspace. Startup tasks run sequentially; a failed task is
logged and does not prevent later tasks.

This executes instructions through an agent run, not as a shell script and not
as a bootstrap file injection. Each run uses a fresh temporary
`agent:<id>:boot:<run-id>` session, cleaned up after success or failure. Existing
sessions and their history are preserved. Normal final-response delivery is disabled;
if the instructions need to notify someone, they must specify a channel and
target for the message tool. Missing or empty files are skipped.

Keep boot instructions short and safe to repeat on every restart. They can use
model and tool capabilities, so enabling this hook can cause model calls and
outbound side effects.

<a id="bootstrap-extra-files"></a>

### bootstrap-extra-files config

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "bootstrap-extra-files": {
          "enabled": true,
          "paths": ["packages/*/AGENTS.md"]
        }
      }
    }
  }
}
```

`paths` is preferred. If it is empty, the handler tries `patterns`, then `files`;
these are alternatives, not merged lists. Without patterns, the hook does nothing.

Paths resolve relative to the event's workspace and must remain inside it,
including after symlink resolution. Only these basenames load: `AGENTS.md`,
`SOUL.md`, `IDENTITY.md`, `USER.md`, `BOOTSTRAP.md`, and `MEMORY.md`.

Extra files go through normal bootstrap filtering and injection limits. Reads
are capped at 2 MiB per file. Injection defaults to 20,000 characters per file
and 60,000 total, controlled by `bootstrapMaxChars` and
`bootstrapTotalMaxChars` in agent defaults or overrides; `USER.md` has a separate
4,000-character cap. Duplicate paths are removed. Subagents retain only
`AGENTS.md`; cron and non-private conversations have additional context/privacy
filters. Inspect the actual injected result with `/context detail`; see
[Context](/concepts/context).

`TOOLS.md` is not a recognized runtime bootstrap basename.
`openclaw doctor --fix` archives workspace-root `TOOLS.md` and merges customized
content into the `## Tools` section of `AGENTS.md`. Other `TOOLS.md` files named
by patterns are not migrated;
point those patterns at `AGENTS.md` instead.

<a id="command-logger"></a>

### command-logger details

Appends one JSON line per emitted command event to
`<stateDir>/logs/commands.log`. Fields are `timestamp`, `action`, `sessionKey`,
`senderId`, and `source`; absent sender/source values become `unknown`.
Core emits `/new`, `/reset`, and `/stop`, not every slash command.

The handler awaits the append, logs write errors, and sends no chat confirmation.
It does not rotate the log. Set appropriate access and retention for the session
and sender identifiers it records. See [Log inspection](/cli/hooks#command-logger-log-file).

<a id="compaction-notifier"></a>

### compaction-notifier details

Adds a short notice before compaction and a completion notice after successful
compaction. Notices can include message counts and before/after token counts
when available. They travel through the compaction caller's notice callback;
without a callback that delivers them, enabling the hook does not guarantee a
visible message. A before notice without an after notice can indicate a
skipped, failed, or interrupted compaction, not a stuck hook. Manual `/compact`
does not supply this hook-message delivery callback, so it is not a reliable
way to test the notices.

<a id="session-memory"></a>

### session-memory details

Saves the ended session's recent user/assistant text on `/new`, `/reset`
(including soft reset), or automatic daily/idle rollover. Automatic rollover
emits `session:auto-reset`, not a synthetic command event. Expiry is checked when
a subsequent turn is admitted; this is not a timer that writes memory at the
daily boundary while the session is idle.

The artifact is `<workspace>/memory/YYYY-MM-DD-HHMM.md` by default, with a
numeric suffix if that filename already exists. Dates use
`agents.defaults.userTimezone`, then process `TZ` when no user timezone is set,
and the host timezone as fallback. The file records session identity and the
command source or automatic reset reason.

| Entry option | Default       | Behavior                                                                                                        |
| ------------ | ------------- | --------------------------------------------------------------------------------------------------------------- |
| `messages`   | `15`          | Recent user/assistant messages to include; use a positive integer.                                              |
| `llmSlug`    | `false`       | Ask a model for a descriptive filename slug.                                                                    |
| `model`      | Agent default | Optional configured alias, bare model ID on the default provider, or `provider/model` used for slug generation. |

The hook captures the departing conversation before a reset closes its active
window, then writes the snapshot in the background. Capture is bounded to
4,096 scanned messages and 8 MiB.
Manual resets do not await the file write or optional slug-model call; automatic
reset dispatch also runs independently of the successor turn. Wait for
`Session context saved to ...` in logs before expecting the file.

This is a filtered excerpt, not a complete transcript or a model-written
summary. It omits slash-command text, tool messages, inter-session user input,
silent reply markers, and duplicate delivery-mirror text. If transcript reading
fails, the artifact can record that content was unavailable. The workspace is
resolved from event/agent config; you do not need to add a `workspace.dir` key.

With `llmSlug: true`, conversation text is sent to the configured model to name
the file. Failure falls back to a timestamp slug. Leave it off if you want no
extra model call for naming.

<Note>
Saved excerpts are workspace memory artifacts. If
[session transcript indexing](/reference/memory-config#session-memory-search)
is also enabled, one conversation can be represented by both `memory` and
`sessions`, adding overlapping results and embedding work. For hook-only recall,
set `memory.search.sources: ["memory"]` and
`memory.search.rememberAcrossConversations: false`; `sources` alone does not stop
cross-conversation recall from adding `sessions`. For full-transcript recall
instead, disable `session-memory`. These search settings do not disable the
hook's file writes or ordinary transcript persistence.
</Note>
