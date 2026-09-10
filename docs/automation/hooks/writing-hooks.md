---
summary: "Hook directory layout, the handler contract, reply delivery, and the HOOK.md metadata fields"
read_when:
  - You are writing a new internal hook and need the file layout
  - You need the handler signature, event fields, or reply-delivery boundary
  - You need the `HOOK.md` frontmatter and `metadata.openclaw` contract
title: "Writing hooks"
---

Hook file layout, the handler contract, reply delivery, and the `HOOK.md` metadata fields. Part of the [Hooks](/automation/hooks) guide.

## Writing hooks

This example replies to a reset command and writes a fixed log marker. It does
not read message content, call a model, or contact an external service.

### Hook structure

On the Gateway host, use a new managed hook directory. The following commands
assume the default state directory and that `reset-greeting` does not already
exist; choose another name rather than overwrite an existing hook.

```bash
mkdir -p ~/.openclaw/hooks/reset-greeting

cat > ~/.openclaw/hooks/reset-greeting/HOOK.md <<'HOOK'
---
name: reset-greeting
description: "Confirm that a reset hook ran"
metadata:
  { "openclaw": { "events": ["command:new", "command:reset"] } }
---

# Reset greeting

Send a short confirmation after an authorized reset command.
HOOK

cat > ~/.openclaw/hooks/reset-greeting/handler.js <<'HANDLER'
export default function handler(event) {
  if (event.type !== "command" || !["new", "reset"].includes(event.action)) {
    return;
  }

  console.log("[reset-greeting] reset hook ran");
  event.messages.push("Reset hook ran.");
}
HANDLER
```

A hook needs `HOOK.md` and a handler file. Discovery checks, in order,
`handler.ts`, `handler.js`, `index.ts`, then `index.js`, using the first file it
finds. The example uses JavaScript so no TypeScript types or SDK imports are
needed.

Enable and load it:

```bash
openclaw hooks info reset-greeting
openclaw hooks enable reset-greeting
```

Send `/new` in a disposable conversation on a configured chat channel that can
route replies, such as a direct message to the bot. Expect **Reset hook ran.**
in that conversation and `[reset-greeting] reset hook ran` in Gateway logs.
`/reset` triggers the same example. Normal command authorization still applies.

Use an ordinary OpenClaw conversation, not an ACP-bound thread; bound sessions
delegate reset handling to their owning runtime. Do not use Control UI/webchat
or a `sessions.reset` RPC as the chat-reply check:
those paths do not deliver this hook's `event.messages` to the UI. The log marker
can still show that a reset event ran. See
[Reply delivery](/automation/hooks/writing-hooks#reply-delivery) for the exact boundary.

Disable the example when finished:

```bash
openclaw hooks disable reset-greeting
```

Disabling leaves the files in place. To use a workspace directory instead, put
the two files in `<workspace>/hooks/reset-greeting/`, then explicitly enable the
hook. Workspace placement is not an agent sandbox or a guarantee that the
Gateway will load that workspace's hooks.

### Handler implementation

A handler exports a function returning `void` or `Promise<void>`. The loader uses
the default export unless `metadata.openclaw.export` names another export.
Returned values do not block, cancel, or rewrite the operation.

Every event has these fields:

| Field        | Meaning                                                                                                                |
| ------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `type`       | Family: `command`, `session`, `agent`, `gateway`, or `message`                                                         |
| `action`     | Action within the family, such as `new` or `compact:before`                                                            |
| `sessionKey` | Session correlation key; Gateway events use a Gateway key instead                                                      |
| `timestamp`  | JavaScript `Date` when the event object was created                                                                    |
| `context`    | Event-specific data described under [Event context highlights](/automation/hooks/event-types#event-context-highlights) |
| `messages`   | Initially empty string array; only certain producers consume it as replies                                             |

Treat context as an observation, not a live state-editing API. Fields vary by
producer, and `cfg` is not present on every event. In particular, patch events
carry cloned snapshots. The explicit mutable exception is
`agent:bootstrap`'s `context.bootstrapFiles`.

### Reply delivery

Pushing to `event.messages` is not a general send-message API:

| Producer                                                                     | What happens to `event.messages`                                                                                                                  |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat command handling for `/new` and `/reset`                                | Awaits handlers, joins strings with blank lines, and attempts a reply to the originating channel/recipient, preserving account and thread context |
| Gateway session reset/create RPCs that emit `command:new` or `command:reset` | Handlers run, but messages are not routed as chat replies                                                                                         |
| `session:compact:before` and `session:compact:after`                         | Forwarded to the caller's compaction-notice callback when present; that callback owns delivery                                                    |
| All other core events                                                        | Ignored as replies, including `/stop`, automatic reset, message events, bootstrap, patch, and Gateway lifecycle events                            |

A missing recipient, unsupported route, send policy, or delivery failure can
prevent a reply. Append messages before the handler's promise settles; detached
work that pushes later can miss the producer's delivery step. To control normal
agent replies or send cancellation, use the appropriate
[typed plugin hook](/plugins/hooks).

### HOOK.md format

`HOOK.md` uses YAML frontmatter followed by human-readable Markdown:

```markdown
---
name: my-hook
description: "Short description of what this hook does"
homepage: https://example.com/my-hook
metadata:
  { "openclaw": { "emoji": "🔗", "events": ["command:new"], "requires": { "bins": ["node"] } } }
---

# My Hook

Explain the side effects, configuration, and verification steps here.
```

`name` defaults to the directory name; use a unique, stable name.
`description` is shown in reports. The following fields belong under
`metadata.openclaw`:

| Field              | Contract                                                                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `events`           | Event-key array. At least one is needed to register a handler.                                                                                                                                                           |
| `export`           | Function export name; defaults to `default`.                                                                                                                                                                             |
| `hookKey`          | Config-entry key; defaults to the hook name. Discovery collisions still use the hook name.                                                                                                                               |
| `emoji`            | Display emoji.                                                                                                                                                                                                           |
| `homepage`         | Documentation URL; overrides top-level `homepage`, `website`, or `url`.                                                                                                                                                  |
| `os`               | Allowed Node platform names, for example `darwin`, `linux`, or `win32`.                                                                                                                                                  |
| `requires.bins`    | Every named executable must be on `PATH`.                                                                                                                                                                                |
| `requires.anyBins` | At least one named executable must be on `PATH`.                                                                                                                                                                         |
| `requires.env`     | Every named variable needs a nonblank process value or per-hook `env` value.                                                                                                                                             |
| `requires.config`  | Every dotted config path must be truthy.                                                                                                                                                                                 |
| `always`           | Bypass binary, environment, and config requirements; does not bypass OS or enablement policy.                                                                                                                            |
| `install`          | Informational install descriptors: `kind` is `bundled`, `npm`, or `git`; optional `id`, `label`, `package`, `repository`, and `bins`. This metadata does not install dependencies or make Git specs accepted by the CLI. |

Use `hooks.internal.entries.<hookKey>.enabled` to control activation, not a
top-level `enabled` flag in `HOOK.md`. For historical requirement metadata,
`workspace.dir`, `browser.enabled`, and `browser.evaluateEnabled` default to true
when absent. `workspace.dir` is not a new setting you need to add to your config.
