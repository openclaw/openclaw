---
summary: "Internal hooks: install, write, and verify automation for commands and lifecycle events"
read_when:
  - You want event-driven automation for /new, /reset, /stop, or session and Gateway events
  - You want to write, install, enable, or debug an internal hook
  - You need to understand hook discovery, event data, or reply delivery
title: "Hooks"
doc-schema-version: 1
---

# Hooks

Internal hooks are small JavaScript or TypeScript handlers that run in the
Gateway process when OpenClaw emits an event. Use them to save session context,
log reset commands, or perform short side effects during message and session
lifecycle events. OpenClaw includes [bundled hooks](/automation/hooks/bundled-hooks)
for common tasks; you do not need to write a plugin to use them.

## Choose the right surface

| You want to…                                                                                                   | Use                                                             |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Save context on `/new`, log commands, or react to session and message events                                   | **Internal hooks** (`HOOK.md` plus a handler), described here   |
| Modify prompts, intercept tools, control replies, or use lifecycle contracts with priorities and return values | **[Plugin hooks](/plugins/hooks)** through `api.on(...)`        |
| Let another service start work through an HTTP request                                                         | **[Webhooks](/automation/cron-jobs#webhooks)**                  |
| Export telemetry rather than change behavior                                                                   | **[Diagnostic events](/logging#diagnostics-and-opentelemetry)** |

These are separate systems. `hooks.internal` configures this page's event
handlers; `hooks.enabled` configures HTTP ingress. Internal event names such as
`message:received` are not typed plugin names such as `message_received`.

<Warning>
Internal hooks are trusted code, not sandboxed scripts. They run with the
Gateway process's filesystem, network, and environment access. Review hook code
before enabling it, especially code from a workspace or downloaded package.
</Warning>

## Quick start

Start with `command-logger`: it needs no extra binaries or model calls and gives
you a concrete file to inspect. Run these commands on the **Gateway host**, with
the same profile and config as that Gateway:

```bash
openclaw hooks list
openclaw hooks info command-logger
openclaw hooks enable command-logger
```

The default `hybrid` [reload mode](/gateway/configuration#reload-modes) applies
hook config changes without a restart. With reload mode `off`, run
`openclaw gateway restart`, or restart a foreground Gateway yourself. Add
`--agent <id>` when your configuration has multiple agents and no implicit owner.

In a conversation you can safely reset, send `/new` or `/reset` as an authorized
user. Then inspect the log on the Gateway host:

```bash
tail -n 5 ~/.openclaw/logs/commands.log
```

Look for a new JSON line with `"action":"new"` or `"action":"reset"`, a recent
`timestamp`, and that conversation's `sessionKey`. With a custom state directory,
read `<stateDir>/logs/commands.log` instead. This proves that a handler ran;
`openclaw hooks check` alone does not.

The log contains session and sender identifiers. Disable the hook after trying
it if you do not want to retain those records:

```bash
openclaw hooks disable command-logger
```

### Eligible, enabled, and loaded

Keep these three checks separate:

- **Requirements satisfied**: the hook's OS, binaries, environment, and config
  requirements pass on the host doing the check.
- **Enabled by config**: the per-hook/source policy allows it. Workspace hooks
  require explicit opt-in; bundled and managed hooks do not require that
  per-hook flag when broad discovery is enabled.
- **Loaded**: the running Gateway selected the hook, imported its handler, and
  registered its events. This also requires the master switch and configured
  name selection to allow it.

The CLI's `ready`, `eligible`, and `loadable` fields describe the first two checks
plus a nonempty event list. They do **not** prove that the Gateway imported the
handler, that the global selection includes it, or that its event has fired.
After changes, verify the actual side effect or hook-specific log.

Config reload prepares the selected handlers before replacing them together.
If a selected handler cannot load, the previous handlers stay active. An event
already running finishes with its original handlers; subsequent events use the
new selection. Reload does not replay `gateway:startup`.

### Local, remote, and agent scope

`hooks list`, `info`, and `check` request the selected Gateway's inventory. An
implicit local Gateway can fall back to local discovery when unavailable or
when it lacks the report method. A configured remote Gateway or explicit
`OPENCLAW_GATEWAY_URL` does not fall back to your laptop's hooks on failure.

`hooks enable` and `hooks disable` always inspect and modify **local config**.
They do not update a remote Gateway over RPC. Run them on the Gateway host to
change that host's hooks.

`--agent <id>` selects the workspace to inspect, not an isolated hook registry.
The saved `hooks.internal.entries.<hookKey>` entry is global. The Gateway
loads directory hooks from its selected workspace into a process-wide registry;
it does not load every agent's `hooks/` directory merely because you inspected
it. A loaded handler must filter the event's agent or session when it should
only act for a particular agent. See [Hook discovery](/automation/hooks/configuration#hook-discovery).

## Plugin hooks

Plugin-managed internal hooks appear as `plugin:<id>` in `hooks list`. They
participate in this event system, but you enable or disable the owning plugin
rather than toggling them with `hooks enable` or `hooks disable`. The directory
loader's configured-name selection is not a policy gate for typed `api.on`
hooks or a substitute for plugin activation.

The legacy `api.registerHook` API registers internal events. It does not invoke
typed lifecycle names such as `before_tool_call`, `message_received`, or
`session_start`; registering those names emits a warning directing authors to
`api.on(...)`. For new integrations needing typed lifecycle control, use the
[Plugin hooks](/plugins/hooks) reference.

## Best practices

Handlers for one event run sequentially: family listeners first, then exact
listeners, in registration order within each group. The dispatcher awaits each
handler, catches and logs thrown errors, and continues to later handlers.
There is no priority option for file hooks.

This sequencing does not serialize different events. Message notifications,
patch notifications, and automatic reset work can overlap with other events and
agent processing. There is no general handler timeout, cancellation signal,
durable event queue, automatic retry, or exactly-once guarantee. Restart or
process exit can lose in-flight work.

Keep side effects short and bounded. Await the work that belongs to the handler,
set timeouts on network calls, limit data sizes, and make repeatable operations
idempotent. Do not use `void doHeavyWork(event)` as a general solution: that work
escapes the handler's wait/error boundary and can outlive its session or process.
If work needs a durable job lifecycle, use an automation or service that owns it.

Filter unrelated events early and avoid logging message bodies, whole config
objects, or credentials. Message and session data can be private. Keep only the
minimum needed for the side effect, protect output files, and set retention.
Long-lived timers, watchers, sockets, and clients belong to a plugin service
with an explicit shutdown lifecycle, not a request/event handler.

## CLI reference

See [`openclaw hooks`](/cli/hooks) for every public report and toggle option,
JSON output fields, exit behavior, and install/update aliases.

## Detailed topics

These pages hold the reference and how-to material that used to follow the
quick start on this page.

| Page                                                                | Read it when                                                                            |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [Writing hooks](/automation/hooks/writing-hooks)                    | You are writing a hook and need the file layout, handler contract, or `HOOK.md` fields. |
| [Hook configuration and discovery](/automation/hooks/configuration) | You are enabling hooks, narrowing the selection, or tracing discovery across sources.   |
| [Bundled hooks](/automation/hooks/bundled-hooks)                    | You want a shipped hook and need its behavior, options, and verification.               |
| [Hook event types and context](/automation/hooks/event-types)       | You need an event key's trigger, wait behavior, or context fields.                      |
| [Hook troubleshooting](/automation/hooks/troubleshooting)           | A hook is not discovered, not eligible, or not executing.                               |

## Where each section moved

Every section heading from the previous single-page version keeps its anchor
here, so an existing link such as `/automation/hooks#session-memory` still
resolves. Each entry points at the page that now holds the content.

- <a id="writing-hooks" />[Writing hooks](/automation/hooks/writing-hooks#writing-hooks)
- <a id="hook-structure" />[Hook structure](/automation/hooks/writing-hooks#hook-structure)
- <a id="handler-implementation" />[Handler implementation](/automation/hooks/writing-hooks#handler-implementation)
- <a id="reply-delivery" />[Reply delivery](/automation/hooks/writing-hooks#reply-delivery)
- <a id="hook.md-format" /><a id="hook-md-format" />[HOOK.md format](/automation/hooks/writing-hooks#hook-md-format)
- <a id="configuration" />[Configuration](/automation/hooks/configuration#configuration)
- <a id="hook-discovery" />[Hook discovery](/automation/hooks/configuration#hook-discovery)
- <a id="hook-packs" />[Hook packs](/automation/hooks/configuration#hook-packs)
- <a id="bundled-hooks" />[Bundled hooks](/automation/hooks/bundled-hooks#bundled-hooks)
- <a id="boot-md" />[boot-md](/automation/hooks/bundled-hooks#boot-md)
- <a id="boot-md-details" />[boot-md details](/automation/hooks/bundled-hooks#boot-md-details)
- <a id="bootstrap-extra-files" />[bootstrap-extra-files](/automation/hooks/bundled-hooks#bootstrap-extra-files)
- <a id="bootstrap-extra-files-config" />[bootstrap-extra-files config](/automation/hooks/bundled-hooks#bootstrap-extra-files-config)
- <a id="command-logger" />[command-logger](/automation/hooks/bundled-hooks#command-logger)
- <a id="command-logger-details" />[command-logger details](/automation/hooks/bundled-hooks#command-logger-details)
- <a id="compaction-notifier" />[compaction-notifier](/automation/hooks/bundled-hooks#compaction-notifier)
- <a id="compaction-notifier-details" />[compaction-notifier details](/automation/hooks/bundled-hooks#compaction-notifier-details)
- <a id="session-memory" />[session-memory](/automation/hooks/bundled-hooks#session-memory)
- <a id="session-memory-details" />[session-memory details](/automation/hooks/bundled-hooks#session-memory-details)
- <a id="event-types" />[Event types](/automation/hooks/event-types#event-types)
- <a id="event-context-highlights" />[Event context highlights](/automation/hooks/event-types#event-context-highlights)
- <a id="message-context" />[Message context](/automation/hooks/event-types#message-context)
- <a id="troubleshooting" />[Troubleshooting](/automation/hooks/troubleshooting#troubleshooting)
- <a id="hook-not-discovered" />[Hook not discovered](/automation/hooks/troubleshooting#hook-not-discovered)
- <a id="hook-not-eligible" />[Hook not eligible](/automation/hooks/troubleshooting#hook-not-eligible)
- <a id="hook-not-executing" />[Hook not executing](/automation/hooks/troubleshooting#hook-not-executing)

## Related

- [CLI Reference: hooks](/cli/hooks)
- [Plugin hooks](/plugins/hooks)
- [Webhooks](/automation/cron-jobs#webhooks)
- [Configuration](/gateway/config-hooks#hooks)
- [Agent workspace](/concepts/agent-workspace)
- [Standing orders](/automation/standing-orders)
