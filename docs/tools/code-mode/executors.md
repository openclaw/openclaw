---
summary: "Choose Node or QuickJS for Code Mode and understand their execution and security boundaries"
title: "Code Mode executors"
doc-schema-version: 1
read_when:
  - You want to choose how Code Mode executes JavaScript
  - You need hardened guest isolation instead of trusted Node execution
  - You are upgrading a config that explicitly selected QuickJS-WASI
---

Code Mode uses **Node** by default when enabled. Select **QuickJS** when you
need a hardened guest runtime. Both executors run the same plain JavaScript
cells, expose the same typed tool discovery, and use the same `exec` and `wait`
tools. With no global Code Mode setting, automatic per-model activation applies.
Choosing an executor in Labs preserves activation. When writing an object in
config, include `enabled: "auto"` to retain automatic activation.

## Choose an executor

| Executor         | Intended use                           | Execution                                                                | Suspended state                      |
| ---------------- | -------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------ |
| `node` (default) | Trusted execution on your Gateway host | Node.js `node:vm` in a worker thread                                     | A live worker and JavaScript context |
| `quickjs`        | Hardened guest isolation               | QuickJS-WASI in a worker thread, supplied by the bundled executor plugin | A serialized VM snapshot             |

<Warning>
Node's `node:vm` is **not a security boundary**. The worker keeps guest
computation off the Gateway event loop, but it shares the Gateway process's
operating-system privileges. Treat Node Code Mode as trusted host execution.
</Warning>

The intended guest API does not expose Node's filesystem, networking, process,
environment, or module-loading APIs. Module guards and a small set of globals
help keep cells focused on tool orchestration; they do not make `node:vm` safe
for hostile JavaScript. Use QuickJS when guest isolation is part of your threat
model, and use a separate OS user, container, or host when you need a stronger
host boundary.

QuickJS provides a separate WASM guest with no ambient host access. It can
still call powerful tools if your tool policy grants them. Calls made through
the Code Mode tool bridge retain OpenClaw's normal policy, approvals, hooks,
and session ownership under either executor. These checks mediate tool calls;
they cannot contain hostile code that escapes a Node VM context.

## Set the executor

In the web interface, open **Settings → Agents & Tools → Labs** and use
**Code Mode executor** to choose **Node.js (default)** or **QuickJS (isolated)**.
Activation and executor selection are separate:
choosing an executor does not enable Code Mode.

To enable Code Mode with the default Node executor:

```json5
{
  tools: {
    codeMode: {
      enabled: true,
      executor: "node",
    },
  },
}
```

For hardened guest isolation, set `executor: "quickjs"` in the same object.
The bundled plugin ID is `code-mode-quickjs`; selecting its executor needs no
separate plugin enable step. Explicit executor selection activates this bundled
runtime even when `plugins.enabled` is `false` or a restrictive `plugins.allow`
list omits it. It does not enable other plugins. An explicit `plugins.deny`
entry or `plugins.entries.code-mode-quickjs.enabled: false` still blocks it.
An external plugin can supply the `quickjs` executor choice and remains subject
to the full plugin activation policy. Enable exactly one owner for that choice.
The selectable executor IDs are `node` and `quickjs`; `node` is owned by core.

The selected executor must be available. If it is missing, disabled, denied,
or cannot load, the run fails with `runtime_unavailable`; OpenClaw never
silently switches to Node or broad direct tool exposure. Check plugin policy
when a configured QuickJS executor is unavailable.

Set `agents.entries.<agent>.tools.codeMode.executor` to override the global
selection for one agent. An agent that omits it inherits the global choice.
See [Code Mode configuration](/tools/code-mode/configuration) for activation
precedence and limits.

## Understand waits and limits

Each cell keeps its selected executor for its entire lifetime, including every
`wait`. Changing configuration affects new cells; it does not move suspended
JavaScript between engines or replay completed tool calls.

Node retains its live worker context while suspended. QuickJS can release its
worker after serializing the guest and restore the snapshot for `wait`. Both
continuations are transient: completion, failure, cancellation, expiry, or
Gateway shutdown releases them. Neither survives a Gateway restart.

`timeoutMs`, output limits, pending-call limits, suspended-run capacity, and
`snapshotTtlSeconds` apply to both executors. The historical
`snapshotTtlSeconds` name also controls Node's suspended-context lifetime.
The host enforces Node's execution deadline by terminating an overdue worker,
including synchronous loops and promise continuations. Output emitted before
the timeout remains available within the configured output limit.
QuickJS additionally checks serialized VM state against `maxSnapshotBytes`.
Node has no serialized VM snapshot, so that setting does not bound its live
heap. Saved JSON results retain their shared memory/snapshot data allowance.

`memoryLimitBytes` limits QuickJS guest memory. For Node, it configures a
best-effort V8 worker heap budget across the old and young generations, subject
to engine minimums. That budget includes worker runtime allocations and
excludes external buffers; it is not a per-context heap measurement or security
boundary. Neither executor's
setting caps total Gateway RSS. Worker overhead and host-side tool results also
consume memory. A retained Node context can use more total host memory than a
size-limited QuickJS snapshot. The shared limit of 64 suspended cells and
reserved resume slots still applies; there is no separate global memory quota. See
[Code Mode internals](/tools/code-mode/internals#run-and-snapshot-lifecycle)
for state ownership and retention.

## Upgrade an existing configuration

Doctor and eligible Gateway startup migrations replace an explicit
`runtime: "quickjs-wasi"` with `executor: "quickjs"`, preserving that explicit
choice. An existing `executor` setting takes precedence when both fields are
present. Activation and other limits remain unchanged.

The migrated explicit QuickJS choice also works when generic plugins are
disabled or allowlisted, without enabling unrelated plugins. An explicit denial
of `code-mode-quickjs` still prevents execution.

Configurations that did not explicitly select a runtime use the new Node
default. Set `executor: "quickjs"` explicitly to retain hardened guest
isolation. The retired `runtime` field is not a runtime alias; use
`openclaw doctor --fix` for an older configuration.

## Related

- [Code Mode quickstart](/tools/code-mode/quickstart)
- [Code Mode configuration](/tools/code-mode/configuration)
- [Security](/gateway/security)
- [Sandboxing](/gateway/sandboxing)
