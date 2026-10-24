---
summary: "Build plugins with typed operations, native pages, and replaceable Control UI views"
title: "Feature plugins"
read_when:
  - You want a plugin to add a native Control UI page or customize the workspace
  - You want the same feature operation available to UI and agent tools
  - You want an agent to build and propose a local plugin artifact
---

A feature plugin can own its backend operations and its Control UI. It can add
pages, navigation, session actions, panels, dashboard widgets, and header
accessories, or provide replacements for the workspace, session list, composer,
transcript, and tool results.

All plugin APIs are [experimental](/plugins/sdk-overview#api-stability),
including the backend and browser contracts on this page. Pin and test your
OpenClaw host version.

Native UI runs trusted JavaScript in the Control UI origin. Install it only from
authors you trust. Native modules share the signed-in operator's Gateway
authority: `host.request` can call any method that connection's scopes allow,
including administrative methods for administrators. Use the existing sandboxed dashboard widget or MCP App
surfaces when the content should be isolated from the host application.

Open the Control UI served by the connected Gateway. Native plugin assets
require that same origin; a separately hosted UI connected to another Gateway
cannot load them and explains which Control UI to open.

Authenticated native UI also requires HTTPS or a browser-trusted loopback URL
such as `http://127.0.0.1:18789/`. Plain HTTP on a LAN address can pair and use
the dashboard, but cannot send the secure cookies used for native assets.
Plugin pages explain how to switch to HTTPS/Tailscale Serve or localhost;
backend operations remain available.

## Enable custom plugin UI

In the Control UI, open **Settings → Labs → Custom plugin UI**. The setting
defaults to off and controls native browser code from user-installed plugins,
including local development plugins. The equivalent config is:

```json5
{
  gateway: {
    controlUi: {
      experimental: { customPlugins: true },
    },
  },
}
```

Changes apply without restarting the Gateway, and connected Control UI pages
refresh their plugin views automatically. Disabling it prevents custom native UI
from loading and removes its views. Reload browser tabs to clear plugin
JavaScript that already ran. This does not uninstall plugins or disable their
backend operations, tools, or services.
Ordinary plugin APIs, sandboxed dashboard widgets, and MCP Apps are unaffected.

Native UI shipped with OpenClaw remains available for enabled bundled plugins,
including Workboard. OpenClaw determines bundled status from the loaded
plugin's origin, not its name or a manifest claim. A separately installed copy
uses the custom-plugin setting.

## Create a feature plugin

Enable the [Custom plugin UI lab](/plugins/feature-plugins#enable-custom-plugin-ui) before opening the
generated plugin's browser views.

```bash
openclaw plugins init draft-review --name "Draft Review" --type feature
cd draft-review
npm install
npm run build
npm run validate
openclaw plugins install .
```

The starter plugin includes a draft-analysis operation, an agent tool, a native page,
and a composer replacement. Open Draft Review from the Control UI sidebar, or
open **Plugins → Advanced → Customize UI** and choose Draft composer. Choose Built-in to
restore a view. Replacement selection belongs to the current browser runtime;
it is not a persistent configuration setting.

Customization controls are the first section in **Plugins → Advanced**. If a
workspace replacement hides navigation, open
`/settings/plugins?tab=advanced` under your Control UI base URL to choose Built-in; plugin settings
always use the built-in workspace.

The project has three public SDK imports:

| Import                                 | Purpose                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `openclaw/plugin-sdk/feature-contract` | Shared operation schemas, typed clients, and event subscriptions; browser safe.                  |
| `openclaw/plugin-sdk/feature-plugin`   | Register backend implementations as session actions, optional agent tools, and command adapters. |
| `openclaw/plugin-sdk/control-ui`       | Native browser activation, host capabilities, contribution types, and component mounts.          |

Browser code owns its DOM and bundles its framework dependencies. It does not
import Control UI internals or return the host framework's templates.

## Define operations once

`defineFeatureContract` declares named queries and actions with TypeBox input
and output schemas. `defineFeaturePlugin` implements them through
`setup(api, events)` and registers each operation on the existing plugin session
action transport. Queries require `operator.read`; actions require
`operator.write`.

An operation with a `tool` declaration also registers an agent tool. Optional
command adapters parse the actual command context and format the result. The
handler receives a discriminated invocation context: `source` is
`session-action`, `tool`, or `command`, with the original context for that
surface. Tool policy, authenticated command handling, and Gateway scope checks
remain owned by their existing execution paths.

Use `createFeatureClient(contract, context.host)` inside a browser view:

```typescript
const feature = createFeatureClient(contract, context.host);
const report = await feature.invoke("analyze", { text: "A draft to inspect" });
context.signal.throwIfAborted();
output.textContent = `${report.words} words`;
```

Backend inputs, outputs, and events are validated as bounded JSON. Define
meaningful limits in the schemas as well. Use the plugin's existing runtime
and storage APIs for durable state and services.

For changing data, declare events in the contract and emit them through the
`events` argument after the plugin service has started. A client can subscribe
with `feature.on(...)` or use `feature.watch(query, input, options)` to request
a fresh snapshot initially, after named events, and after reconnect. `watch`
requires `onChange` and `onError`, returns a disposer, and rejects stale results
after a newer refresh or view disposal. It does not poll.

## Contribute and replace views

Export `defineControlUiPlugin({ id, activate(host) })` from the browser entry.
Its id must match the plugin manifest. Register contributions through
`host.ui`; each registration returns a disposer.

| Registration                            | Host placement                                                                                                                          |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `registerPage` and `registerNavigation` | Plugin-owned routes and sidebar destinations.                                                                                           |
| `registerAction`                        | Composer, header, or session menu actions. An optional `resolve` function supplies the current label, hidden state, and disabled state. |
| `registerPanel`                         | Session panels.                                                                                                                         |
| `registerAccessory`                     | Session header content.                                                                                                                 |
| `registerInlineView`                    | Data-populated native views in the chat transcript.                                                                                     |
| `registerWidget`                        | Native dashboard widget views.                                                                                                          |
| `registerReplacement`                   | `workspace`, `session-list`, `composer`, `transcript`, or `tool-result`.                                                                |

Set a navigation item's `parent` to another navigation ID in the same plugin to
show it nested while the parent or a child destination is active; children only
appear as top-level entries when pinned. Set `defaultVisible: false` to offer an
item in **Customize**, and call `host.ui.pinNavigation(id)` after registering it
to append an ordinary saved sidebar pin. Pinning is a no-op for an unknown or
already pinned ID; call it for a user action such as creation, not on every
catalog refresh, so a later manual removal stays removed.

Navigation items can supply `actions` with an `id`, `label`, optional `icon` and
`destructive` flag, and a `run` callback. The sidebar opens these actions on
right-click, **Shift+F10**, or the context-menu key on the focused link, including
nested and pinned entries. Selecting an action closes the menu; **Escape** or an
outside click dismisses it. Use `host.ui.isNavigationPinned(id)` to read a saved
pin and `host.ui.unpinNavigation(id)` to remove it; repeated calls have no additional effect. Plugins choose
which actions to offer and own confirmation for destructive actions.

For a dashboard widget, also register a backend
`api.session.controls.registerControlUiDescriptor` with `surface: "widget"`,
the same widget `id`, and its `requiredScopes`. The Gateway advertises widget
kinds for the current connection's scopes; a native view renders only when its
matching backend descriptor is advertised.

Use `host.ui.openPanel("editor", { sessionKey, agentId })` to open one of your
registered panels beside a session. Omitting the session uses the currently
selected session. The host owns navigation and sidebar presentation, including
opening from a plugin page before the session pane has mounted. Only the same
plugin's registered panels can be opened; retained handles expire with their
view or activation.

For a document link, use `host.navigation.pageHref(...)` to build a link to a
registered plugin page. That page can resolve its document and call `openPanel`
with the target session. This does not intercept ordinary file links or change
the Files plugin's ownership.

Use `host.ui.invalidate()` when plugin-owned state changes the presentation of
an action or another contribution. Namespace custom elements and CSS with the
plugin id so independently bundled plugins can coexist.

A view mounts into an `HTMLElement` and receives `context.host`, `props`,
`signal`, `presented`, and `mountDefault`. Return an object with `update`,
`focus`, and `dispose` as needed. Surface props and presentation changes arrive
through `update`; use `context.host.subscribe(...)` to observe host snapshot
changes. A view that remains mounted retains its host lifetime when `presented`
is false; use it to pause visual work while preserving state. Removing or disposing
the view aborts its signal and retires its host handles. Check the signal after
asynchronous work and release plugin resources in `dispose`.

Session-bound views and actions receive `sessionKey` and `agentId`. Carry both
when making a session request: the application's selected agent can differ from
the view's agent. Changing either part of that identity retires the old view's
handles, including retained composer operations. Header and composer actions also
retire when their pane stops being presented. A later return to that pane allows
new actions; it does not revive handles from an earlier invocation.

Replacements can compose the built-in view by calling
`context.mountDefault(container)`. A workspace replacement should use this
when it wants to retain the built-in chat state and session owners. The SDK
does not expose a separate headless chat service for a completely independent
workspace.

A composer replacement receives the current draft, admission state, disabled
reason, and standard `setDraft`, `send`, and optional `abort` operations. Use
these operations instead of issuing a raw chat RPC. `send()` resolves `true`
when admitted, `false` when rejected, or `undefined` for a local command or no
submission. Show rejected submissions rather than clearing the draft. Composer
operations retire when the view stops being presented, even while its DOM and
host lifetime survive. Use the fresh operations supplied by `update` when the
view is presented again; previously captured operations remain retired.

### Host capabilities

Use the host for shared application behavior:

| Capability              | Purpose                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| `agents`                | Agent snapshots, selection, scope, and refresh.                                                               |
| `components`            | Host-owned dialogs, pickers, and session dashboards.                                                          |
| `connection`            | Current connection and operator capabilities.                                                                 |
| `dock` (optional)       | Open a conversation beside the current page with `openSession`, close the dock, and observe `openSessionKey`. |
| `navigation`            | Open plugin pages and build their URLs.                                                                       |
| `request` and `onEvent` | Authenticated Gateway requests and event subscriptions.                                                       |
| `sessions`              | Session snapshots, independent queries, navigation, creation, and updates.                                    |
| `subscribe`             | Observe host snapshot changes, including the docked session key.                                              |
| `ui`                    | Register, select, and invalidate plugin contributions.                                                        |

`onEvent("session.message", listener)` listeners receive complete messages;
delivery begins once the Gateway confirms full-body delivery for this connection.
The host requests complete roster bodies when the first such listener registers
and releases that preference when the last listener is removed. Listeners
registered before connect include the preference in the initial handshake.
During runtime registration, bodyless roster frames already in flight still
update core UI consumers but are never delivered to plugin listeners. Other
event subscriptions are unchanged, and no reconnect is required.

Session and agent `refresh()` operations fetch new snapshots and reject on failure, so a plugin
can display an error and offer Retry. `host.sessions.rows` is the current
filtered, paginated session list. `host.sessions.refresh()` preserves that
list's filters. Use `host.sessions.observe(query, onChange)` to maintain an
independent session query without replacing it. The query accepts `agentId`,
`search`, `archived` (`true`, `false`, or `"all"`), `limit`, `configuredAgentsOnly`,
`includeGlobal`, `includeUnknown`, `excludeDock`, `includeDerivedTitles`, and
`includeLastMessage`. The callback receives `{ result, loading, error }`,
starting with the current snapshot; `result` is null until data is available.
Results contain `sessions` and the Gateway's `hasMore`, `nextOffset`, and
`totalCount` pagination metadata.

Create a conversation with `host.sessions.create({ agentId, displayName?, label?,
surface? })`. `displayName` is a reusable display title; `label` is a unique
session label. For a conversation owned by a plugin page's dock, pass
`surface: "plugin-dock"`. This immutable creation-surface marker hides the
conversation from ordinary session lists without changing its human creator,
access, sharing, or sandbox rules. Rows expose `isDock` and `createdSurface`;
`createdVia` retains its ordinary operator provenance.
Independent host list queries exclude dock conversations by default; pass
`excludeDock: false` when deliberately including them.
The session key remains usable with `host.dock.openSession` and direct reads.

The host fetches the query and keeps it current through session events,
observer recovery, and its normal deletion handling. `observe` returns
`{ refresh, dispose }`: call `refresh()` for an explicit retry and `dispose()`
when the query is no longer needed. Errors appear in the snapshot, and an
explicit refresh rejects on failure. View disposal also releases its queries;
retained handles and unfinished refreshes reject after that lifetime ends.

A missing row in a filtered or incomplete list does not prove that a session
was deleted. Pending deletions can also hide rows before pagination metadata
changes. Pass `{ sessionKey: row.key, agentId: row.agentId }` to
`host.sessions.open`, `host.sessions.patch`, and a dashboard's `session` prop.
Carry the identity from the returned row: a raw `global` key belongs to its
queried agent, not the current selection or a card's assigned agent. Treat an
unresolved or ambiguous search as unknown. Session action presentation updates
when the roster changes, and actions check the current row again when invoked.
Actions can inspect `session.hasActiveRun`; an absent value means activity is
not yet known.
`host.components`
mounts host-owned dialogs, agent pickers, searchable select pickers, and session
dashboards from plain props and DOM content. Each component returns `update` and `dispose` methods;
the host retains permission checks, focus handling, and dashboard provider
ownership. Use `mountSelectPicker` for a list of `{ value, label, description? }`
options, a selected `value`, an `accessibleLabel`, and an `onSelect` callback.
With `searchable: true`, lists longer than eight options show a search field.
The picker matches option labels, values, and descriptions.

### Dock a conversation

Check `host.dock` before offering a dock action. From a mounted view, use
`context.host.dock.openSession({ sessionKey, agentId, label, context })` to open
the named conversation alongside your plugin page. `label` supplies the dock
tab title; the optional `context` is `{ page, detail? }`, where `page` can be
your plugin page id and `detail` contains string reference fields.

The host reuses the Home dock's placement controls, chat pane, drafts, and
attachments. Page navigation keeps the conversation dock open; ending the
plugin activation closes a dock that activation still owns. Use
`host.subscribe(...)` to refresh your action when `host.dock.openSessionKey`
changes. See the [dock contract](/plugins/sdk-subpaths#control-ui-conversation-dock)
for replacement, visibility, access, and context limits.

## Inline views from tools

A native plugin can register a predefined inline component and return **data** for
it from a tool. The agent selects the tool and its arguments; it does not author
HTML, JavaScript, templates, or a component. This is native plugin UI, not a
sandboxed widget or MCP App.

Register the backend display contract and return its descriptor:

```typescript
api.session.controls.registerControlUiDescriptor({
  id: "incident-dashboard",
  surface: "inline",
  label: "Incident dashboard",
  requiredScopes: ["operator.read"],
  version: 1,
});

api.registerTool({
  name: "show_incident",
  label: "Show incident",
  description: "Show an incident dashboard.",
  parameters: {
    type: "object",
    properties: { incidentId: { type: "string" } },
    required: ["incidentId"],
  },
  async execute(_toolCallId, args: { incidentId: string }) {
    return api.inlineView(
      "incident-dashboard",
      { incidentId: args.incidentId },
      {
        version: 1,
        summary: `Showing incident ${args.incidentId}.`,
      },
    );
  },
});
```

The helper binds the canonical manifest plugin id (not the display name). It
returns ordinary text content containing the required nonblank summary, plus
`details: { pluginInlineView: { pluginId, viewId, version, payload, summary } }`.

Payloads must be plain JSON, at most **16 KiB of serialized UTF-8**. Summaries
are at most **4 KiB of serialized UTF-8 JSON**, keeping the complete result within nested tool
history limits. Store larger data in the plugin and pass an ordinary resource
id. The helper requires an explicit integer interface version from **1 to 65535**.
The native tool host binds the record to its originating invocation; model text,
arbitrary MCP results, and imported external JSON cannot claim that association.
Core checks bounded JSON, not plugin data semantics. Plugin code owns semantic
validation, and HTML-looking strings are not inspected or blocked by core.

In the browser entry, register the matching installed component:

```typescript
export default defineControlUiPlugin({
  id: "incident-tools",
  activate(host) {
    host.ui.registerInlineView({
      id: "incident-dashboard",
      version: 1,
      mount(element, context) {
        const heading = document.createElement("h3");
        heading.textContent = "Incident dashboard";
        element.append(heading);
        // Read context.props.payload and fetch the resource through context.host.
        return { dispose: () => heading.remove() };
      },
    });
  },
});
```

The host supplies `payload`, `toolCallId`, `toolName`, `sessionKey`, and
`agentId`. Payload fields cannot override that context. Each tool call owns
an independent view, keyed by its owning run and tool-call id; repeated receipt of the same
result does not add another instance. There is no in-place tool-driven update
protocol in this version. Use plugin-owned state and `host.ui.invalidate()`
for interactive state shared with another view.

- **Live:** the view appears as soon as its successful tool result arrives,
  after its summary, without waiting for the agent final reply or expanding
  tool details. Direct and nested Tool Search calls use their actual call identity.
- **History:** reload reconstructs the display from the stored descriptor,
  never by rerunning the agent or tool. Only rows near the scroll viewport mount
  components. Offscreen instances are disposed/aborted; a measured-height
  placeholder preserves scrolling while the row remains present. Virtualization
  can remove the entire row, and scrolling back may mount a new instance.
- **Availability:** the backend descriptor, browser registration, current viewer
  scopes, plugin enablement, and Custom plugin UI lab must still permit the view.
  Missing plugins/views, unsupported interface versions, loading, and activation
  failures preserve the saved summary. Availability is derived at presentation
  time; it is not stored or transferred in the record and never discards payload.
  Reinstalling a compatible renderer can display the same saved data without
  rerunning tools. No original caller privilege is inherited by a later viewer.
- **Errors:** a thrown mount/update error or `context.reportError?.(error)`
  retires that instance and offers **Retry plugin view**. A stale instance cannot
  report an error against its replacement. Handle ordinary action errors inside
  your component when a full remount is not appropriate.
- **Versioning:** the backend declaration, browser registration, and saved record
  must match exactly on plugin id, view id, and interface version. This version is
  independent of the plugin package version. Register versions 1 and 2 alongside
  each other to keep both histories displayable; each can reuse or adapt plugin
  code. Core never guesses the newest renderer from a schema, archives renderer
  bundles, or migrates payloads. Unversioned records do not mount native views.
- **Other surfaces:** text-only clients/model context receive the tool normal
  summary content; this feature does not force channel tool-progress delivery.
  Inline views are not dashboard pins or hosted/embed dispatch targets.

### Persistence and transfer

The canonical durable record is { pluginId, viewId, version, payload, summary }.
Native transcript storage and the native HTML session export retain it and its
host-bound invocation metadata, including when the plugin is absent. The HTML
export embeds the full session data, not executable plugin renderer bundles; it
does not mount native plugins itself or provide a general rich-session importer.

Control UI Markdown export and the native session-catalog/Beam mirror are
**minimal text exports**: they deliberately emit the saved summary, without the
component payload or mounting authority. Beam's current closed text protocol
and catalog text imports do **not** implement full-fidelity inline-view transfer.
External imports remain untrusted text and do not become authorized native views.

Both historical data policies are valid and plugin-owned:

- **Dynamic reference:** save an ordinary resource id and read fresh data when
  mounted. The incident example follows this policy. Historical loss, deleted
  resources, and changed server state are the plugin's responsibility.
- **Snapshot:** save self-contained bounded data for a historical display.

Core restores the saved reference/data with an explicitly compatible installed
renderer; it does not promise identical historical pixels or prohibit network
reads. Mounting may hydrate through plugin Gateway methods, but never reruns the
original tool or model.

### Inline plugin author responsibilities

Mounting must be repeatable display/read work. Do not acknowledge an incident,
submit a payment, or mutate a resource just because history was scrolled into
view. Mutations belong to an explicit click or the original authorized tool.
Release subscriptions, observers, and framework roots in `dispose`, and honor
`context.signal` after asynchronous work.

Native plugins run with the existing installation trust boundary and current
connection authority. The host does not add a sandbox, per-plugin RPC allowlist,
or generic HTML policing. Plugin authors own safe rendering: prefer
`textContent`/framework text interpolation for data. If your component uses
HTML, URL, script, or other executable sinks, validate/sanitize for that sink.
Never persist credentials, secrets, or bearer-capability references in a payload
or summary. On every backend request, authorize the **current viewer** against
resource/session ACLs; a saved resource id is not authorization.

See the runnable [incident example](https://github.com/openclaw/openclaw/tree/main/examples/inline-incident):
it reads current status, acknowledges through a scope-checked plugin Gateway
method on an explicit button click, and shares plugin state with a session panel
opened using both `sessionKey` and `agentId`.

## Build and reload

`package.json` names the browser **source**:

```json
{
  "openclaw": {
    "extensions": ["./dist/index.js"],
    "controlUi": "./src/control-ui.ts"
  }
}
```

`openclaw plugins build` bundles that source and its browser dependencies with
the plugin's `esbuild` dev dependency. It writes immutable JavaScript and CSS
under `dist/control-ui/<content-hash>/`, then publishes their paths in
`openclaw.plugin.json.controlUi`. A failed build leaves the previous manifest
and assets usable. `plugins validate` and `plugins build --check` detect stale
source, assets, or generated metadata.

Host runtime builds keep the authored root manifest unchanged and publish their
browser declaration in `dist/openclaw.plugin.json`. That generated declaration
replaces only `controlUi`; config schemas and activation still come from the root
manifest. Explicit `plugins build` publishes the root declaration and retires
the previous generated pointer. Both layouts keep asset paths relative to the
plugin root.

### Solid views

Solid 2 is supported for native plugin views. Use a `.tsx` browser entry and
declare `solid-js` and `@solidjs/web` as your plugin's runtime dependencies,
with matching versions. Add `@solidjs/compiler` and `esbuild` to its development
dependencies. Put `/** @jsxImportSource @solidjs/web */` before the imports in
each Solid `.tsx` file. This standard JSX pragma selects the plugin's own Solid
compiler; other JSX files retain esbuild's existing renderer semantics. The
builder bundles the renderer, and the host does not supply a shared runtime.
For typechecking, set `jsx: "preserve"` and `jsxImportSource: "@solidjs/web"`.

The framework-neutral view contract stays the same:

```tsx
import { render } from "@solidjs/web";
import type { ControlUiView } from "openclaw/plugin-sdk/control-ui";
/** @jsxImportSource @solidjs/web */
import { createSignal } from "solid-js";

const mount: ControlUiView = (container, context) => {
  const [label, setLabel] = createSignal(context.props.label ?? "Ready");
  const dispose = render(() => <p>{label()}</p>, container);
  return {
    update(next) {
      setLabel(next.props.label ?? "Ready");
    },
    dispose,
  };
};
```

Keep one renderer responsible for each container's children and dispose its root
when the view ends. Solid 2 batches reactive writes; keep synchronous request
authority and mutation guards with their existing owners.

### Packaged Settings presentations

A bundled presentation can render a host-owned Settings placement without
activating the plugin's runtime UI. Memory Core uses this for the Memory overview and indexed-search panel,
including when memory is off, another engine is selected, or the Gateway is offline.
Declare the placement alongside the built entry:

```json
{
  "controlUi": {
    "entry": "dist/control-ui/<content-hash>/index.js",
    "activation": "settings-only",
    "settingsViews": [
      { "section": "memory", "panel": "overview" },
      { "section": "memory", "panel": "memories" }
    ]
  }
}
```

The browser module exports `pluginId` and a `settingsViews` array of
`ControlUiSettingsView` from `openclaw/plugin-sdk/control-ui`. Each view declares
its `placement` and a `mount(container, context)` that returns `update(snapshot)`
and `dispose()`. Memory views support the overview and Memories panel. A channel plugin can instead declare
`{ "section": "channels", "panel": "detail", "channelId": "<owned-channel>" }` and export a
`ControlUiChannelSettingsView`. The channel must appear in the declaring manifest's `channels`.
These placements do not register arbitrary Settings routes.

The host supplies the selected Settings agent, engine availability, connection
state, advertised Gateway methods, locale, shared Settings components, and bounded navigation. Authenticated
operator RPC remains trusted native UI authority, bound to the mounted view's
lifetime. A memory view stays mounted through a same-client reconnect: `connected` and
`connectionEpoch` arrive through `update(snapshot)`, and a reply to a request sent in an earlier
epoch rejects. Agent, engine, route, advertised method catalog, Gateway client, account or
recovery identity, and operator-access changes end the view; retained callbacks then reject.
An absent method catalog means the method is unavailable. The host keeps
routing, agent selection, engine decisions, and config writes; the plugin owns
its presentation, status requests, and indexed-memory search. Search and full-file
reads remain agent-scoped through the existing Gateway methods. Only an explicit
user action searches memory or probes embedding readiness.

A channel view receives status/account metadata, locale, connection state, and a
`presented` flag. Its draft belongs to the Channels page: closing or switching the
detail modal detaches its DOM without disposing the view. Same-client reconnects
retain the draft but retire in-flight requests. Gateway/client, channel owner,
plugin runtime, config owner, or administrator-access replacement ends the view.
Keep pending-operation identity synchronous and stop rendering hidden updates
until the view is presented again.

`context.mountConfig(container)` mounts the real host-owned channel schema editor;
its returned disposer releases that slot. `context.refresh(probe)` refreshes channel
status. The channel context's `request` accepts an account ID, relative path
segments, `PUT` or `POST`, a JSON body, and a caller cancellation signal. The host
encodes the path once under `/api/channels/<owned-channel>/<account>/`, retains
credentials, and checks connected administrator authority before dispatch, before
credential retry, and after consuming the response body. Plugins never receive
arbitrary credentialed URLs, headers, or tokens. A plugin may add its own operation
deadline, which also covers retries and response-body consumption. The context
returns parsed JSON plus HTTP status and a sanitized error message; backend route
validation and mutation authority remain unchanged.

The optional `login` capability connects a channel presentation to an existing
application-owned login flow shared with setup. Its snapshot exposes the current
message, QR image, connected state, and busy state; opaque login session keys stay
with the host. `start(force)` and `wait()` retain the setup account selection.
`captureLogout()` returns the selected account and a guarded logout callback;
capture it before awaiting the host's `confirm` dialog. Account or linked-state
changes, lost administrator access, replaced owners, and ended connection epochs
invalidate that callback. Closing the detail does not reset the shared login flow.
The host confirmation retains normal dialog admission and cancels when its view
or transport lifetime ends. Optional phone and duration formatters preserve the
host's locale conventions.

The normal plugin builder preserves this declaration. The Control UI build
loads it from the completed bundled distribution with the same package identity,
asset revision, and immutable JavaScript/CSS generation. A Settings-only entry
is excluded from runtime UI activation; existing `defineControlUiPlugin` entries
keep their required `activate(host)` contract.

Source-checkout `pnpm ui:build` and `pnpm ui:dev` prepare declared Settings
presentations through the same plugin builder before reading that distribution.
The dev server serves the validated generated JavaScript and CSS without runtime
plugin activation. Restart the dev server after editing plugin presentation
sources to rebuild their immutable generation.

### Bundle boundaries

The build emits a JavaScript entry, optional CSS, and JavaScript chunks for lazy
imports. The content hash covers the complete generation, including its chunks.
CSS remains attached to the entry; loading a JavaScript chunk does not attach
stylesheets. Authenticated bootstrap advertises the entry, stylesheets, and static
JavaScript dependencies so the browser can preload them together before the
Gateway connection completes. Activation still waits for the current catalog,
asset grants, and all stylesheets; dynamic imports remain lazy.
Embed other static assets in the bundle; arbitrary files are
outside this build contract. Imports must be analyzable by esbuild: literal
paths and supported glob imports work; unresolved dynamic imports, indirect
`require` calls, and `require.resolve` are rejected. Import validation checks the
emitted chunks after tree-shaking: unused dependency loaders may be removed, but
every retained browser import must resolve to a bundled chunk. Each asset is limited to
4 MiB, with an 8 MiB and 128-asset limit for the whole plugin browser build.

Plugins with prebuilt browser bundles can omit `package.json.openclaw.controlUi`
and declare the built entry and styles in `openclaw.plugin.json.controlUi`.
Packing and serving include JavaScript and CSS dependencies under that entry's
directory, including nested chunks and imported stylesheets, with the same byte
limits. TypeScript sources, source maps, and hidden files are excluded. Keep all browser
dependencies inside that directory; traversal is limited to eight nested directory
levels and 128 entries, counting both files and directories.

After browser-only edits, rebuild the installed plugin and open **Plugins → Advanced →
Customize UI → Reload plugin UI** as an administrator. The Gateway captures a fresh asset revision and
notifies connected browsers. Asset loading or activation failures are reported
in the UI customization controls; the previous working activation is retained
when possible. Retry after correcting the plugin, or select Built-in to
recover a replaced view.

Advertised asset revisions remain available for the lifetime of their backend
plugin, including imports needed by an older tab or a retained working view.
The shared cache holds at most 256 revisions and 64 MiB across all native
plugins. When it fills, reload refuses the new build and preserves advertised
assets. Restart the Gateway, then retry the reload.

On first activation, plugin pages and dashboard widgets show a loading state
while the catalog, asset authorization, and initializer complete. Each plugin
becomes available independently of other plugins that are still loading. A
disconnected view waits for the Gateway connection before checking availability.
Widgets show initialization failures with a Retry action.

Registrations and replacement selections made during activation publish
together after initialization succeeds. Disposing a registration before that
point also cancels its pending selection. Invalid selections reject the new
activation without retiring the preceding working UI.

Selected replacements survive a successful revision when the contribution
still exists for that surface. Unregistering the contribution, removing its
plugin, or reconnecting clears the choice; reusing an ID does not restore it.

Custom element definitions belong to the browser document. If a plugin changes
an existing custom element class, reload the browser tab as well, or use a new
versioned tag name.

Backend changes use [plugin update or Reload](/cli/plugins/uninstall-and-update)
to replace the running plugin without restarting the Gateway. Browser
reload does not replace backend services or change an already running agent's
tool catalog.

## Approve an agent-built artifact

After building and validating, produce an import archive:

```bash
openclaw plugins pack --root . --out ./draft-review.tgz --json
```

The receipt contains the absolute archive path, SHA-256 digest, plugin id, and
`plugin_activate_artifact` request. Packing bundles backend dependencies, keeps
the host `openclaw` imports external, and includes the manifest and compiled UI.
The archive contains no install scripts or runtime package dependencies. It
must have one backend entry; features that require separate runtime files need
the normal reviewed package-install flow. Packing rejects backend references to
`import.meta`, `__dirname`, `__filename`, and `require.resolve`, including those
in bundled dependencies, because their original files and locations do not
travel with the artifact. Import JSON or embed other resources in the backend
build instead.

Backend imports must also be analyzable by esbuild. Direct CommonJS imports
work, including Node builtins and the host SDK. Unresolved dynamic imports,
indirect `require` calls, and prebundles with opaque runtime loaders are rejected.
Provide an entry compiled without those loaders so packing can bundle its
dependencies, or use the normal package-install flow.

The system agent can propose activation with that path and digest. Before
approval, OpenClaw verifies and retains the exact archive and inspects its
declared capabilities and native UI presence without executing the plugin.
Approved application uses those retained bytes through the managed plugin
installer. Changing the source file while approval is pending cannot change
what is installed. Existing install policy and capability checks still apply.

Artifact approval does not enable the Custom plugin UI lab. The installed
backend can run with that setting off; its native browser UI remains gated.

Pending imports expire after one hour. OpenClaw keeps at most eight pending
archives of up to 32 MiB each and prunes expired or oldest imports when another
proposal is prepared. An expired or evicted review requires a fresh proposal.
Approved archives are retained separately as the install source, including when
an installer error leaves the final installation outcome uncertain.

Artifact activation currently requires plugin configuration in the root config
file without a root-level `$include`. For a `plugins` section containing only
`$include: "plugins.json5"` (a single file under the config directory with no
nested includes), use `openclaw plugins install <archive>` from a trusted shell.
The regular installer also rejects root-level, nested, and external include
layouts; adjust those layouts before installation.

Artifact activation also refuses to replace the plugin backing OpenClaw's active
inference route. Stop OpenClaw and install that artifact from a trusted shell.

Gateway-hosted artifact activation waits for backend runtime application. Terminal
or other hosts without a live Gateway lifecycle callback save the install and
report the writer's follow-up; that result is not a runtime application receipt.
Once the Gateway has applied the plugin, inspect `plugins.controlUi.status` to see
activation reports from currently connected Control UI clients. A report names the plugin
revision and either `activated` or `failed`; it is a browser activation receipt,
not proof that every feature operation has been exercised. No connected browser
means no browser activation receipt yet.
Each catalog refresh sends its activation receipts together after the plugins
finish initializing or reach their activation deadline. Healthy plugins become
available immediately while other plugins are still initializing.

For the underlying manifest fields, see [Plugin manifest](/plugins/manifest).
For install, update, and removal, see [Manage plugins](/plugins/manage-plugins).
