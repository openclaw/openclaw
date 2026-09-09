---
summary: "Import map, registration API reference, and SDK architecture"
title: "Plugin SDK overview"
sidebarTitle: "Plugin SDK overview"
read_when:
  - You need to know which SDK subpath to import from
  - You want a reference for all registration methods on OpenClawPluginApi
  - You are looking up a specific SDK export
---

The plugin SDK is the typed contract between plugins and core. This page is the
reference for **what to import** and **what you can register**.

<Note>
  This page is for plugin authors using `openclaw/plugin-sdk/*` inside
  OpenClaw. For external apps, scripts, dashboards, CI jobs, and IDE extensions
  that want to run agents through the Gateway, use
  [Gateway integrations for external apps](/gateway/external-apps) instead.
</Note>

<Tip>
Looking for a how-to guide instead? Start with [Building plugins](/plugins/building-plugins). Use [Channel plugins](/plugins/sdk-channel-plugins) for channels, [Provider plugins](/plugins/sdk-provider-plugins) for model providers, [CLI backend plugins](/plugins/cli-backend-plugins) for local AI CLI backends, [Agent harness plugins](/plugins/sdk-agent-harness) for native agent executors, and [Plugin hooks](/plugins/hooks) for tool or lifecycle hooks.
</Tip>

## API stability

All OpenClaw plugin APIs are **experimental**. This includes every
`openclaw/plugin-sdk/*` subpath, registration and runtime APIs, channel and
provider contracts, hooks, and native Control UI APIs. These contracts can
change between OpenClaw releases.

Pin the OpenClaw version used to develop and deploy your plugin, and test each
host version you declare compatible. Set package compatibility ranges from
those tested versions; do not assume a working build supports future releases.
Existing [compatibility windows and upgrade migrations](/plugins/compatibility)
still apply. Experimental status does not remove a documented migration path.

Native UI from user-installed plugins also requires the default-off
[Custom plugin UI lab](/plugins/feature-plugins#enable-custom-plugin-ui).
Backend plugin APIs and ordinary plugin loading do not require that setting.

## What each page covers

- [Imports and module layout](/plugins/sdk-overview/imports) — which subpath to import from, the subpath catalog, and the internal barrel convention.
- [Capability registration](/plugins/sdk-overview/capabilities) — provider registrars plus the worker-provider and embedding runtime contracts.
- [Tools and commands](/plugins/sdk-overview/tools-and-commands) — agent tools, custom commands, node-host commands, and widget presenters.
- [Infrastructure registration](/plugins/sdk-overview/infrastructure) — hooks, HTTP routes, Gateway methods, services, and the webhook and SQLite helpers.
- [Host hooks](/plugins/sdk-overview/host-hooks) — session extensions, trusted tool policies, Control UI descriptors, and runtime lifecycle.
- [CLI and discovery](/plugins/sdk-overview/cli-and-discovery) — Gateway discovery advertisers, plugin CLI registration, and CLI backends.
- [Memory and context slots](/plugins/sdk-overview/memory-and-context) — the exclusive context-engine and memory-capability slots and their adapters.
- [Events and hook semantics](/plugins/sdk-overview/events-and-hooks) — typed lifecycle hooks and the decision rules each hook applies.

## Registration API

The `register(api)` callback receives an `OpenClawPluginApi` object with these
methods:

Plugins that provide an external team-chat surface for a session can register
the single process-wide provider exported by
`openclaw/plugin-sdk/session-discussion`. Its `info({ sessionKey })` method
reports whether a discussion is unavailable, ready to open, or already open;
`open({ sessionKey })` creates or resolves the discussion and returns its embed
and external URLs. Registering another provider replaces the current provider.

Each group of registration methods has its own page:

| Group                                                                                       | What it registers                                                     |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [Capability registration](/plugins/sdk-overview/capabilities#capability-registration)       | Inference, media, search, transcript, worker, and embedding providers |
| [Tools and commands](/plugins/sdk-overview/tools-and-commands#tools-and-commands)           | Agent tools, custom commands, node-host commands, widget presenters   |
| [Infrastructure](/plugins/sdk-overview/infrastructure#infrastructure)                       | Hooks, HTTP routes, Gateway methods, CLI, services, migrations        |
| [Host hooks](/plugins/sdk-overview/host-hooks#host-hooks-for-workflow-plugins)              | Session extensions, trusted tool policies, Control UI descriptors     |
| [CLI and discovery](/plugins/sdk-overview/cli-and-discovery#gateway-discovery-registration) | Gateway discovery advertisers, CLI registrars, CLI backends           |
| [Exclusive slots](/plugins/sdk-overview/memory-and-context#exclusive-slots)                 | Context engine and memory capability, one active at a time            |
| [Events and lifecycle](/plugins/sdk-overview/events-and-hooks#events-and-lifecycle)         | Typed lifecycle hooks and conversation binding callbacks              |

### API object fields

| Field                    | Type                      | Description                                                                               |
| ------------------------ | ------------------------- | ----------------------------------------------------------------------------------------- |
| `api.id`                 | `string`                  | Plugin id                                                                                 |
| `api.name`               | `string`                  | Display name                                                                              |
| `api.version`            | `string?`                 | Plugin version (optional)                                                                 |
| `api.description`        | `string?`                 | Plugin description (optional)                                                             |
| `api.source`             | `string`                  | Plugin source path                                                                        |
| `api.rootDir`            | `string?`                 | Plugin root directory (optional)                                                          |
| `api.config`             | `OpenClawConfig`          | Current config snapshot (active in-memory runtime snapshot when available)                |
| `api.pluginConfig`       | `Record<string, unknown>` | Plugin-specific config from `plugins.entries.<id>.config`                                 |
| `api.runtime`            | `PluginRuntime`           | [Runtime helpers](/plugins/sdk-runtime)                                                   |
| `api.logger`             | `PluginLogger`            | Scoped logger (`debug`, `info`, `warn`, `error`)                                          |
| `api.registrationMode`   | `PluginRegistrationMode`  | Current load mode; `"setup-runtime"` is the lightweight setup flow with runtime available |
| `api.resolvePath(input)` | `(string) => string`      | Resolve path relative to plugin root                                                      |

## Where each section moved

Every section of the single-page version now lives on this page or on one of
the eight child pages below. The anchors from the single-page version still
resolve here.

- <a id="import-convention" />[Import convention](/plugins/sdk-overview/imports#import-convention)
- <a id="subpath-reference" />[Subpath reference](/plugins/sdk-overview/imports#subpath-reference)
- <a id="capability-registration" />[Capability registration](/plugins/sdk-overview/capabilities#capability-registration)
- <a id="tools-and-commands" />[Tools and commands](/plugins/sdk-overview/tools-and-commands#tools-and-commands)
- <a id="infrastructure" />[Infrastructure](/plugins/sdk-overview/infrastructure#infrastructure)
- <a id="file-watch-capacity-errors" />[File-watch capacity errors](/plugins/sdk-overview/infrastructure#file-watch-capacity-errors)
- <a id="sqlite-write-admission" />[SQLite write admission](/plugins/sdk-overview/infrastructure#sqlite-write-admission)
- <a id="webhook-body-rejection" />[Webhook body rejection](/plugins/sdk-overview/infrastructure#webhook-body-rejection)
- <a id="post-ack-webhook-work" />[Post-ack webhook work](/plugins/sdk-overview/infrastructure#post-ack-webhook-work)
- <a id="requester-scoped-mcp-connections" />[Requester-scoped MCP connections](/plugins/sdk-overview/infrastructure#requester-scoped-mcp-connections)
- <a id="host-hooks-for-workflow-plugins" />[Host hooks for workflow plugins](/plugins/sdk-overview/host-hooks#host-hooks-for-workflow-plugins)
- <a id="when-to-use-tool-result-middleware" />[When to use tool-result middleware](/plugins/sdk-overview/host-hooks#when-to-use-tool-result-middleware)
- <a id="gateway-discovery-registration" />[Gateway discovery registration](/plugins/sdk-overview/cli-and-discovery#gateway-discovery-registration)
- <a id="cli-registration-metadata" />[CLI registration metadata](/plugins/sdk-overview/cli-and-discovery#cli-registration-metadata)
- <a id="cli-backend-registration" />[CLI backend registration](/plugins/sdk-overview/cli-and-discovery#cli-backend-registration)
- <a id="exclusive-slots" />[Exclusive slots](/plugins/sdk-overview/memory-and-context#exclusive-slots)
- <a id="memory-embedding-adapters" />[Memory embedding adapters](/plugins/sdk-overview/memory-and-context#memory-embedding-adapters)
- <a id="events-and-lifecycle" />[Events and lifecycle](/plugins/sdk-overview/events-and-hooks#events-and-lifecycle)
- <a id="hook-decision-semantics" />[Hook decision semantics](/plugins/sdk-overview/events-and-hooks#hook-decision-semantics)
- <a id="internal-module-convention" />[Internal module convention](/plugins/sdk-overview/imports#internal-module-convention)

## Related

<CardGroup cols={2}>
  <Card title="Entry points" icon="door-open" href="/plugins/sdk-entrypoints">
    `definePluginEntry` and `defineChannelPluginEntry` options.
  </Card>
  <Card title="Runtime helpers" icon="gears" href="/plugins/sdk-runtime">
    Full `api.runtime` namespace reference.
  </Card>
  <Card title="Setup and config" icon="sliders" href="/plugins/sdk-setup">
    Packaging, manifests, and config schemas.
  </Card>
  <Card title="Testing" icon="vial" href="/plugins/sdk-testing">
    Test utilities and lint rules.
  </Card>
  <Card title="SDK migration" icon="arrows-turn-right" href="/plugins/sdk-migration">
    Migrating from deprecated surfaces.
  </Card>
  <Card title="Plugin internals" icon="diagram-project" href="/plugins/architecture">
    Deep architecture and capability model.
  </Card>
</CardGroup>
