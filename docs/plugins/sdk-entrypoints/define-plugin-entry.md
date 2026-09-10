---
summary: "The general entry helper, its fields, and the session catalog provider contract"
title: "Plugin SDK definePluginEntry helper"
sidebarTitle: "definePluginEntry"
read_when:
  - You are writing a provider, hook, or advanced tool plugin
  - You are registering an external session catalog provider
  - You need the definePluginEntry field table
---

The entry helper for provider plugins, advanced tool plugins, hook plugins,
and anything that is not a messaging channel. Part of the
[Plugin entry points](/plugins/sdk-entrypoints) reference.

## `definePluginEntry`

**Import:** `openclaw/plugin-sdk/plugin-entry`

For provider plugins, advanced tool plugins, hook plugins, and anything that
is **not** a messaging channel.

```typescript
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "my-plugin",
  name: "My Plugin",
  description: "Short summary",
  register(api) {
    api.registerProvider({/* ... */});
    api.registerTool({/* ... */});
  },
});
```

| Field                     | Type                                                             | Required | Default             |
| ------------------------- | ---------------------------------------------------------------- | -------- | ------------------- |
| `id`                      | `string`                                                         | Yes      | -                   |
| `name`                    | `string`                                                         | Yes      | -                   |
| `description`             | `string`                                                         | Yes      | -                   |
| `kind`                    | `string` (deprecated, see below)                                 | No       | -                   |
| `configSchema`            | `OpenClawPluginConfigSchema \| () => OpenClawPluginConfigSchema` | No       | Empty object schema |
| `reload`                  | `OpenClawPluginReloadRegistration`                               | No       | -                   |
| `nodeHostCommands`        | `OpenClawPluginNodeHostCommand[]`                                | No       | -                   |
| `securityAuditCollectors` | `OpenClawPluginSecurityAuditCollector[]`                         | No       | -                   |
| `register`                | `(api: OpenClawPluginApi) => void`                               | Yes      | -                   |

- `id` must match your `openclaw.plugin.json` manifest.
- External session catalogs use
  `openclaw/plugin-sdk/session-catalog` and register a
  `SessionCatalogProvider` with `api.registerSessionCatalog(...)`. Required
  provider fields are `id`, `label`, `list`, and `read`; optional hooks are
  `resolveCreateSession`, `continueSession`, `copyToGatewaySession`,
  `checkUpstreamActivity`, `archive`, `openTerminal`, and `startTerminalSession`.
  Core owns the
  `sessions.catalog.*` Gateway methods; providers return host, session,
  transcript, and terminal-plan projections without registering RPCs. A list
  provider should call the optional
  `onHost(host)` callback as each host settles; the returned host array remains
  required as the final compatibility snapshot.

  If a host can finish after `list` returns a fail-soft snapshot, register its
  bounded completion with the optional `waitUntil(completion: Promise<void>)`
  hook before `list` settles. Include host mapping and the `onHost` call in that
  promise. Use `publishSessionCatalogHost({ onHost, waitUntil }, pendingHost)`
  from the same SDK entry point to publish the host and register the complete
  callback chain. Registration after `list` settles is rejected. Providers that
  do not register completion work finish publishing when their `list` settles.

  The optional `signal: AbortSignal` belongs to the catalog operation or provider
  lifetime. Pass it to cancellable work, including the top-level `signal` field
  of `api.runtime.nodes.invoke(...)`. A requesting client disconnect only removes
  that client's subscription; it does not cancel shared discovery. Retaining
  completion does not extend native invocation or fail-soft response deadlines,
  grant new authority, or permit starting work after the owner retires. Providers
  remain responsible for bounded work that settles after cancellation.

  Keep `onHost`, `waitUntil`, and `signal` separate from validated catalog query
  objects and node command payloads. The request-owned `sessionEntries` snapshot
  and `listNodes` hook still must not be retained past `list`; prepare any facts
  needed by late host mapping before returning.

  Transcript items may include a `sender` with a qualified `SessionParticipant`
  identity and optional display label or avatar. Supply only source-known
  attribution; the viewer and the session adopter are not transcript authors.
  Core resolves profile identities against current profile data, including merges.
  User items without attribution display as **User**.

  A Gateway-hosted catalog may set `audience: "gateway-operators"` when every
  authenticated operator with `operator.read` may view its rows. Such a provider
  may implement `copyToGatewaySession(...)` to return a bounded display name and
  optional preferred model for an independent Gateway-owned continuation. Core
  owns operator and agent authorization, session creation, model readiness and
  policy checks, rollback, and untrusted-content wrapping. The provider supplies
  transcript text through `read(...)`; it must not write the destination session.

  Native source titles are presentation, not unique session labels. When adopting
  a new source, pass its title as `displayName` to the owner-authorized
  [session creator](/plugins/sdk-runtime); the host bounds and stores that snapshot
  with the new row. Keep source identity independent of naming, preserve existing
  labels and snapshots on reuse or recovery, and do not resync native renames.

  A provider may declare one readable transcript route with `shareRoute`. This
  is a closed contract, not a free-form routing hint:

  ```ts
  const shareRoute = {
    kind: "thread-id-prefix",
    routeSegment: "my-sessions",
    hostId: "gateway",
    identifierAlphabet: "lowercase-hex",
    fullLength: 32,
    minPrefixLength: 12,
    lookup: "catalog-list-search-by-thread-id-prefix",
    ambiguity: "multiple-results-or-next-cursor",
  } as const;
  ```

  The provider must return lowercase hexadecimal `threadId` values of exactly
  32 characters on the declared host. When `list(...)` receives a `search`
  value that is a valid 12-32 character prefix, that host must return only rows
  whose `threadId` starts with the prefix. Return every match up to the requested
  limit and set `nextCursor` when more may exist. The Control UI resolves only
  one result with no next page; multiple rows or `nextCursor` are explicitly
  ambiguous and never select the first row.

  Named share links use `/<routeSegment>/<title-slug>-<id-prefix>` with the same
  bounded slug as regular session links. Return the title in the catalog row's
  `name`; the Control UI uses it to refresh the decorative slug. Only the id
  suffix selects the transcript. Bare-id and stale-title links remain valid,
  and titles never resolve an ambiguous id.

  `routeSegment` must not use the first segment of a built-in Control UI route
  or alias, and it must be unique across active session catalogs. Invalid,
  unsupported, reserved, or multiply owned descriptors fail closed; catalog
  sessions remain available through the generic
  `/chat/<agent>?catalog=...&host=...&thread=...` URL. The shared session URL
  contract owns the built-in reservation decision: its share-path builder
  returns `null` for reserved segments, and the Gateway omits reserved
  descriptors before publishing catalogs. Keep one plugin-owned descriptor
  constant and reuse it for registration, prefix lookup, and URL generation so
  those obligations cannot drift.

  CLI-backed catalogs that expose the same local-plus-paired-node shape can use
  `createSessionCatalogFamily(...)`. The family composer owns canonical cursor
  validation, node payload validation, host projection, adopted-session
  projection, per-host publication, read routing, single-flight continuation
  per resolved agent and source, and terminal plan routing. Different agents
  do not share in-flight adoption results; adopted-source lookup keys remain
  host/thread pairs. The provider must supply its local store reads,
  identifiers and commands, error text, capability projection, continuation
  availability and persistence operations, upstream-activity check, and terminal
  executable/arguments. There are no default continuation, capability-mutation,
  or terminal authorities. Use `createSessionCatalogNodeHostBindings(...)` to
  build the matching list/read/terminal node commands and terminal-only invoke
  policy from those explicit provider inputs.

  The same entrypoint exports `sessionCatalogPaging`, which groups the bounded
  list/read parameter parsers, canonical base64url cursor codec, and bounded
  UTF-8 transcript pager. Providers pass their own identifier pattern and
  validation messages into `parseReadParams(...)` and `parseListParams(...)`.

  `resolveCreateSession({ agentId })` must return a config-derived model/runtime
  target before OpenClaw advertises model-chat creation. Native terminal readiness
  is independent of this target.
  Use
  [`api.runtime.agent.resolveSessionCatalogCreateTarget(...)`](/plugins/sdk-runtime#api-runtime-agent)
  to apply the host's runtime and model-allowlist policy instead of duplicating
  it.

  `startTerminalSession` advertises `capabilities.startTerminal: true` independently
  of model-chat creation. Return `canStartTerminal: true` on each eligible host
  from the ordinary catalog `list` callback, including empty hosts. Publish the
  same flag in progressive `onHost` frames and final results; explicitly return
  `false` when readiness changes. A failed transcript listing does not revoke
  an otherwise available CLI. Node hosts require their exact connected, invocable
  fresh-start command; start-only nodes must not invoke a missing list command.
  Preserve local source IDs and process-home isolation. The shipped
  `createSession.startTerminal` field remains model-chat metadata; new terminal
  callers use the independent capability and raw catalog hosts.

  `startTerminalSession({ agentId, cwd, initialMessage?, nodeId?, hostId? })` creates a
  fresh CLI terminal plan. Return either a local plan (`kind: "local"`, `argv`,
  and the exact `cwd`, plus optional `env`, `pathEnv`, and `title`) or a paired-node
  plan (`kind: "node"`, `nodeId`, `command`, `paramsJSON`, and the exact `cwd`).
  The `sessions.catalog.startTerminal` RPC requires `operator.admin` plus
  `gateway.cliAgents.enabled` and `gateway.terminal.enabled`. The caller
  provisions `cwd`; the Gateway requires an existing absolute local directory,
  rejects a changed plan cwd or host, and applies the normal agent-sandbox,
  node-pairing, deadline, and connection-ownership checks before opening the
  PTY. `hostId` carries the selected local source; `nodeId` identifies a node.
  Initial prompts are bounded to 16,384 characters and cwd to 4,096 characters
  (4,096 UTF-8 bytes on nodes).
  Fresh node commands use `decodeNodePtyStartParams` from `node-host` and
  `runNodePtyCommand({ ..., requiredCwd: true }, io)` to require an existing absolute
  node directory, including a recheck immediately before spawning. Resume retains
  its existing cwd fallback contract. Node payloads must not accept executable,
  argv, environment, credentials, or a Gateway agent as native account selection.

  Paired-node plans that run an interactive CLI directly can declare
  `uploadPathStyle: "native"` when it accepts double-quoted POSIX paths and
  simple double-quoted Windows drive or UNC paths as file references. Native
  Windows formatting preserves apostrophes and backslashes, and rejects double
  quotes and control characters. Declare the same contract through
  `terminal.uploadPathStyle` in `createSessionCatalogFamily(...)`. Leave the field
  absent for shells or other input syntaxes. The Gateway includes it in
  `terminal.upload` results only for clients advertising
  `terminal-upload-path-style`. Without an upload style, clients use the terminal's
  shell quoting rules.

  The terminal manager retains the native title and actual connection/agent owner
  across attach and reconnect. Clients advertise `terminal-session-metadata` to
  receive attach title/owner and list titles; older closed response shapes stay
  unchanged.

- `kind` is deprecated: declare an exclusive slot (`"memory"` or
  `"context-engine"`) in the `openclaw.plugin.json` manifest `kind` field
  instead. Runtime-entry `kind` remains only as a compatibility fallback for
  older plugins.
- `configSchema` can be a function for lazy evaluation. OpenClaw resolves and
  memoizes the schema on first access, so expensive schema builders only run
  once.
- A `nodeHostCommands` descriptor can define `isAvailable({ config, env })`.
  Returning `false` omits that command and its capability from the headless
  node's Gateway declaration. OpenClaw evaluates it against the node-local
  startup config; command handlers should still validate availability when
  invoked.
