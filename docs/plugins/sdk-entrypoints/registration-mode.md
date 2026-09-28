---
summary: "How api.registrationMode reports the load mode and what to register in each"
title: "Plugin SDK registration mode"
sidebarTitle: "Registration mode"
read_when:
  - You need to know what to register in each registration mode
  - You are handling cli-metadata, discovery, or setup-runtime loads
---

How `api.registrationMode` reports the way a plugin was loaded, and what each
mode expects a plugin to register. Part of the
[Plugin entry points](/plugins/sdk-entrypoints) reference.

## Registration mode

`api.registrationMode` tells your plugin how it was loaded:

| Mode               | When                                               | Runtime     | What to register                                                                                                |
| ------------------ | -------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------- |
| `"full"`           | Normal gateway startup                             | Live        | Everything                                                                                                      |
| `"discovery"`      | Read-only capability discovery                     | Live        | Channel registration, static CLI descriptors, and inert providers; skip sockets, workers, clients, and services |
| `"tool-discovery"` | Scoped load to list or run specific plugins' tools | Live        | Capability/tool registration only; no channel activation                                                        |
| `"setup-only"`     | Disabled/unconfigured channel                      | Unavailable | Channel registration only                                                                                       |
| `"setup-runtime"`  | Setup flow with runtime available                  | Live        | Channel registration plus only the lightweight runtime needed during setup                                      |
| `"cli-metadata"`   | Root help / CLI metadata capture                   | Unavailable | CLI descriptors only                                                                                            |

In `"cli-metadata"` and `"setup-only"` modes, accessing a runtime capability throws an error naming the plugin and mode. Defer runtime access out of `register()` or declare root commands in the manifest's `cliCommands` so CLI metadata can be collected without executing the plugin.

`defineChannelPluginEntry` handles this split automatically. If you use
`definePluginEntry` directly for a channel, check mode yourself and remember
`"tool-discovery"` skips channel registration:

```typescript
register(api) {
  if (
    api.registrationMode === "cli-metadata" ||
    api.registrationMode === "discovery" ||
    api.registrationMode === "full"
  ) {
    api.registerCli(/* ... */);
    if (api.registrationMode === "cli-metadata") return;
  }

  if (api.registrationMode === "tool-discovery") {
    // Register capability-only surfaces (providers/tools), no channel.
    return;
  }

  api.registerChannel({ plugin: myPlugin });
  if (api.registrationMode !== "full") return;

  // Heavy runtime-only registrations
  api.registerService(/* ... */);
}
```

Long-lived services may emit small invalidation or lifecycle events through
their service context:

```typescript
api.registerService({
  id: "index-events",
  start(ctx) {
    ctx.gatewayEvents?.emit("changed", { revision: 1 }, { scope: "operator.read" });
  },
});
```

OpenClaw namespaces this as `plugin.<plugin-id>.changed`. Event names are one
lowercase segment, payloads must be bounded JSON, and the scope must be
`operator.read`, `operator.write`, or `operator.admin`. The emitter exists only
for the service lifetime and is revoked after stop or failed start. Prefer
version or invalidation payloads over full records so authorized clients reread
canonical state through the plugin's scoped Gateway methods.

Discovery mode builds a non-activating registry snapshot. It may still
evaluate the plugin entry and the channel plugin object so OpenClaw can
register channel capabilities and static CLI descriptors. Treat module
evaluation in discovery as trusted but lightweight: no network clients,
subprocesses, listeners, database connections, background workers,
credential reads, or other live runtime side effects at top level.

Treat `"setup-runtime"` as the window where setup-only startup surfaces must
exist without re-entering the full bundled channel runtime. Good fits are
channel registration, setup-safe HTTP routes, setup-safe gateway methods,
and delegated setup helpers. Heavy background services, CLI registrars, and
provider/client SDK bootstraps still belong in `"full"`.
