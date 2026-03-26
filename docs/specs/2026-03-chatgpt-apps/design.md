# Feature Design: ChatGPT Apps via Codex App Server

**Date:** 2026-03-26  
**Status:** Draft  
**Owner:** OpenAI plugin / Apps integration

## Goal

Support ChatGPT apps inside OpenClaw-backed agent sessions by using the Codex
app-server as the control plane for ChatGPT auth projection and app inventory,
while keeping OpenClaw as the root owner of `openai-codex` credentials and
existing tool-approval behavior.

This document supersedes the earlier "native bridge only" direction. The source
material shows that Codex app exposure is not just a thin `/api/codex/apps`
wrapper. The local app-server owns important behavior that OpenClaw should not
reimplement:

- external ChatGPT token login
- account and auth state projection
- `app/list` pagination and `app/list/updated` notifications
- merging directory inventory with currently accessible connectors
- future compatibility with workspace directory variants and install/link flows

## Scope

In scope:

- Run a local `codex app-server` sidecar from OpenClaw.
- Project OpenClaw's current `openai-codex` OAuth state into that sidecar using
  the external `chatgptAuthTokens` login path.
- Use `app/list` as the authoritative app inventory API.
- Mirror OpenClaw app enablement into an OpenClaw-owned Codex runtime/config
  sandbox rather than depending on the user's `~/.codex`.
- Expose app tools to OpenClaw sessions through a local stdio MCP bridge.
- Keep the existing OpenClaw auth sink, approval flow, sandbox rules, and audit
  surfaces.

Out of scope:

- Replacing OpenClaw's existing `openai-codex` auth store with Codex-owned auth.
- Full Codex desktop parity for thread/session management, `/apps` UI, or
  Codex thread conversations.
- Shipping connector link creation in milestone 1.
- Depending on Codex's personal `config.toml` or `CODEX_HOME` as user-managed
  state for OpenClaw behavior.

## What The Source Docs Establish

The source material gives five design constraints that matter directly for
OpenClaw:

1. `app/list` is the authoritative app directory surface.
   The Codex apps UI does not read `/api/codex/apps` directly. It calls
   `app/list` over the app-server transport and consumes `AppInfo[]` plus
   `app/list/updated`.

2. The app-server owns inventory assembly.
   The local app-server merges:
   - accessible connectors discovered from the synthetic `codex_apps` MCP tools
   - directory connectors loaded from the lower-level connectors directory APIs

3. External ChatGPT auth is a projected state, not a self-refreshing source of
   truth.
   `LoginAccountParams` supports `type: "chatgptAuthTokens"`, but the generated
   `GetAccountParams` documentation explicitly says proactive refresh is ignored
   in external auth mode. Clients must refresh tokens themselves and call
   `account/login/start` again.

4. The app-server RPC surface exposes app inventory, but not a generic "list
   app tools" or "call app tool" API.
   The known client request set includes `app/list`, `account/read`,
   `getAuthStatus`, `mcpServerStatus/list`, and other app-server methods, but
   not a first-class `app/tools/list` or `app/tools/call` RPC. The actual app
   tool surface still lives behind the synthetic `codex_apps` MCP endpoint.

5. OpenClaw's current bundle MCP support is stdio-only.
   OpenClaw can inject stdio MCP servers into embedded Pi and supported CLI
   backends today, but not mount a remote Streamable HTTP MCP endpoint directly
   from plugin config. That means OpenClaw still needs a local stdio bridge even
   if the remote tool source is ChatGPT-hosted.

These constraints lead to a hybrid architecture:

- use Codex app-server for auth projection and inventory
- use a small OpenClaw-owned stdio MCP bridge for actual tool exposure

## Decision Summary

OpenClaw should adopt a three-layer design:

1. **OpenClaw remains the root auth owner**
   `openai-codex` OAuth stays in OpenClaw's auth profile store. OpenClaw
   refreshes it using the existing auth profile runtime.

2. **Codex app-server becomes the apps control plane**
   OpenClaw launches `codex app-server --analytics-default-enabled`, logs it in
   through `account/login/start` with `type: "chatgptAuthTokens"`, and uses
   `app/list` plus `app/list/updated` as the authoritative app inventory API.

3. **A local OpenClaw stdio MCP bridge exposes the actual tools**
   Because OpenClaw cannot mount remote HTTP MCP directly today, a local bridge
   fetches the remote `codex_apps` tool surface, filters it using the current
   `app/list` snapshot, rewrites names to avoid collisions, and forwards
   `tools/call` back to ChatGPT.

This is intentionally not "app-server only." The app-server does not currently
offer a public RPC for app tool schemas or generic app tool execution, so
OpenClaw still needs the local MCP bridge for the final tool surface.

## Current OpenClaw State

- OpenClaw already owns `openai-codex` OAuth login, storage, and refresh.
  Relevant code:
  - `src/plugins/provider-auth-choice.ts`
  - `extensions/openai/openai-codex-provider.ts`
  - `src/agents/auth-profiles/oauth.ts`
  - `docs/flows/ref.chatgpt-login.md`

- OpenClaw already knows how to use ChatGPT bearer auth plus
  `ChatGPT-Account-Id` for Codex-specific endpoints.
  Relevant code:
  - `src/infra/provider-usage.fetch.codex.ts`

- OpenClaw already injects stdio MCP servers into embedded Pi and supported CLI
  backends.
  Relevant code:
  - `src/agents/embedded-pi-mcp.ts`
  - `src/agents/pi-project-settings.ts`
  - `src/agents/cli-runner/bundle-mcp.ts`
  - `src/plugins/bundle-mcp.ts`

- OpenClaw does not have native plugin-owned managed MCP servers yet. That
  capability is still needed, and this design keeps it, because the local
  ChatGPT apps bridge must be injected like any other managed stdio MCP server.

## Proposed Architecture

```text
+-------------------------+
| OpenClaw auth store     |
| openai-codex OAuth      |
+-------------------------+
            |
            v
+-------------------------+
| Auth projector          |
| refresh + login/start   |
| chatgptAuthTokens       |
+-------------------------+
            |
            v
+-------------------------+
| codex app-server        |
| account/read            |
| app/list                |
| app/list/updated        |
+-------------------------+
            |
     inventory / status
            |
            v
+-------------------------+
| OpenClaw apps service   |
| cache + enablement      |
| diagnostics             |
+-------------------------+
            |
            v
+-------------------------+
| OpenClaw stdio MCP      |
| bridge                  |
| tools/list + tools/call |
+-------------------------+
            |
     filtered remote MCP
            |
            v
+-------------------------+
| ChatGPT codex_apps MCP  |
| /backend-api/wham/apps  |
| or /api/codex/apps      |
+-------------------------+
```

## Detailed Design

### 1) Add a Codex app-server supervisor

OpenClaw needs a local sidecar manager that owns the `codex app-server`
process lifecycle and JSON-RPC transport.

Responsibilities:

- resolve the `codex` executable
- launch `codex app-server --analytics-default-enabled`
- maintain one live connection per OpenClaw agent/workspace scope
- reconnect or restart the sidecar on unexpected exit
- serialize startup so multiple sessions do not race to spawn the same sidecar

Launch strategy:

- default command: `codex app-server --analytics-default-enabled`
- config override: `plugins.entries.openai.config.chatgptApps.appServer.command`
- optional args override: `plugins.entries.openai.config.chatgptApps.appServer.args`

State isolation:

- The sidecar must run inside an OpenClaw-owned Codex runtime directory rather
  than the user's normal `~/.codex`.
- This keeps OpenClaw app enablement, cache state, and any app-server config
  derived from OpenClaw config from drifting against a separate Codex desktop
  install.

Recommended scope:

- one sidecar per `(agentDir, workspaceDir, feature-config hash)`
- shared across concurrent sessions for that scope
- torn down when idle or when OpenClaw exits

### 2) Keep OpenClaw as the root auth sink and project auth into the sidecar

OpenClaw should keep using its existing `openai-codex` auth profile runtime for
refresh and storage. The app-server receives a projected external-auth session,
not an independently managed login.

Auth projection flow:

1. Resolve the active `openai-codex` credential through the existing auth
   profile runtime.
2. Require a usable access token.
3. Require a `chatgptAccountId`.
4. Call app-server `account/login/start` with:

```ts
{
  type: "chatgptAuthTokens",
  accessToken,
  chatgptAccountId,
  chatgptPlanType,
}
```

Why this design:

- `LoginAccountParams` explicitly supports `chatgptAuthTokens`.
- `GetAccountParams.refreshToken` explicitly documents that external auth does
  not proactively refresh itself.
- OpenClaw already has working token refresh and account-bound auth storage.

Implications:

- OpenClaw must refresh first, then re-project into the sidecar.
- OpenClaw should not rely on app-server `getAuthStatus(refreshToken=true)` or
  `account/read(refreshToken=true)` for external auth.
- Milestone 1 does not implement the app-server
  `ChatgptAuthTokensRefresh` server request flow.

Failure handling:

- If OpenClaw has no `openai-codex` profile, the feature is unavailable.
- If OpenClaw has an access token but no `accountId`, fail closed with a
  re-login diagnostic. The app-server external token login requires
  `chatgptAccountId`.

### 3) Use `app/list` as the authoritative app inventory

OpenClaw should stop planning to synthesize its own app directory from raw
`/api/codex/apps` or undocumented directory-list behavior. The app-server
already performs that merge and exposes the stable client-facing `AppInfo`
shape.

OpenClaw inventory service behavior:

- call `app/list` with pagination until `nextCursor == null`
- use `forceRefetch: true` for hard refreshes
- do not send `threadId` in milestone 1
- subscribe to `app/list/updated` and replace the cached inventory on arrival

Important fields in `AppInfo`:

- `id`
- `name`
- `description`
- `installUrl`
- `isAccessible`
- `isEnabled`
- `pluginDisplayNames`

OpenClaw semantics:

- `isAccessible` means the current ChatGPT account has the connector linked and
  usable
- `isEnabled` should reflect OpenClaw local enablement, not user-edited Codex
  config

To make `isEnabled` meaningful, OpenClaw should manage the sidecar's effective
Codex app config itself.

### 4) Mirror OpenClaw enablement into an isolated sidecar config

OpenClaw should keep operator control in OpenClaw config, then derive the
sidecar's enablement from it.

Proposed OpenClaw config:

```json
{
  "plugins": {
    "entries": {
      "openai": {
        "config": {
          "chatgptApps": {
            "enabled": false,
            "chatgptBaseUrl": "https://chatgpt.com",
            "appServer": {
              "command": "codex",
              "args": ["app-server", "--analytics-default-enabled"]
            },
            "connectors": {
              "google_drive": { "enabled": true },
              "gmail": { "enabled": false }
            }
          }
        }
      }
    }
  }
}
```

Precedence:

1. top-level `mcp.servers` remains the highest-precedence operator override
2. `plugins.entries.openai.config.chatgptApps.*` owns ChatGPT apps behavior
3. the Codex sidecar config is a derived artifact, not user-authored state

Implementation detail:

- before calling `app/list`, OpenClaw writes or updates the isolated Codex
  config for the sidecar so `apps.<id>.enabled` matches OpenClaw config
- that makes app-server `AppInfo.isEnabled` line up with OpenClaw's local view

### 5) Add a local stdio MCP bridge for actual tool exposure

The app-server inventory is necessary but not sufficient. OpenClaw still needs
an MCP server that Pi and CLI backends can consume.

Why the bridge is still required:

- OpenClaw bundle MCP support is stdio-only today.
- The app-server client RPC surface does not expose a generic app-tool schema or
  tool-call API.
- The actual app tool definitions still live behind the remote `codex_apps` MCP
  surface.

Bridge behavior:

- register a managed stdio MCP server such as `openai-chatgpt-apps`
- on `tools/list`:
  - ensure sidecar auth projection is current
  - refresh or read the cached `app/list` snapshot
  - fetch the remote `codex_apps` tool list
  - filter remote tools down to connectors present in `app/list` with:
    - `isAccessible == true`
    - `isEnabled == true`
  - rewrite tool names into a deterministic OpenClaw-safe namespace
  - cache the routing metadata needed for `tools/call`
- on `tools/call`:
  - map local rewritten name back to remote tool id + metadata
  - forward the call to the remote `codex_apps` MCP endpoint
  - pass through results and structured content

Name rewriting:

```text
chatgpt_app__<connectorId>__<toolName>
```

This avoids collisions with:

- native OpenClaw tools
- other MCP servers
- other ChatGPT app tools with overlapping names

### 6) Use the correct ChatGPT apps endpoint derivation

OpenClaw must not blindly reuse the current `openai-codex` model base URL
(`https://chatgpt.com/backend-api`) when constructing the remote apps endpoint.

The Codex source flow establishes a separate URL derivation rule for the
synthetic `codex_apps` server:

- `https://chatgpt.com` -> `https://chatgpt.com/backend-api/wham/apps`
- `https://chat.openai.com` -> `https://chat.openai.com/backend-api/wham/apps`
- a base that already contains `/api/codex` -> append `/apps`
- other bases -> append `/api/codex/apps`

OpenClaw design rule:

- introduce `chatgptBaseUrl` specifically for apps integration
- default it to `https://chatgpt.com`
- derive the remote apps MCP URL using the same Codex rules
- do not derive the apps URL from the model transport base URL

### 7) Define cache boundaries and invalidation

There are two separate caches:

1. **Inventory cache**
   Source: app-server `app/list`
   Contents: authoritative `AppInfo[]`
   Invalidated by:
   - `app/list/updated`
   - auth projection changes
   - OpenClaw connector enablement changes
   - explicit hard refresh

2. **Tool schema cache**
   Source: remote `codex_apps` `tools/list`
   Contents: filtered and rewritten tool definitions plus routing metadata
   Invalidated by:
   - inventory cache change
   - token/account change
   - bridge restart
   - explicit hard refresh

The bridge should never expose tools for connectors that are absent from the
current final `app/list` snapshot, even if the remote tool list still includes
them transiently.

### 8) Keep OpenClaw safety and audit semantics unchanged

The resulting app tools remain ordinary MCP tools inside OpenClaw.

That means:

- normal tool approval still applies
- sandbox rules still apply
- tool usage still appears in OpenClaw transcripts/logs
- connector tools do not bypass OpenClaw's normal tool governance

The design intentionally avoids direct in-process bypasses or ChatGPT-specific
special cases in the tool runner.

## Integration Flows

### Session startup flow

1. OpenClaw loads plugin config.
2. If `chatgptApps.enabled == false`, no sidecar or bridge is injected.
3. If enabled:
   - ensure `codex app-server` sidecar is running
   - resolve current `openai-codex` auth
   - project auth via `account/login/start(chatgptAuthTokens)`
   - write derived sidecar config for connector enablement
   - register the local stdio MCP bridge into the session MCP config

### Inventory refresh flow

1. Bridge or diagnostics code requests current apps inventory.
2. Inventory service ensures fresh OpenClaw auth and re-projects if needed.
3. Inventory service calls paginated `app/list`.
4. Inventory cache stores the final `AppInfo[]`.
5. Any `app/list/updated` notification replaces that cache.

### Tool list flow

1. OpenClaw runtime calls local bridge `tools/list`.
2. Bridge reads current inventory cache.
3. Bridge resolves the remote `codex_apps` endpoint from `chatgptBaseUrl`.
4. Bridge calls remote `initialize` and `tools/list`.
5. Bridge filters to connectors whose current `AppInfo` is accessible and
   enabled.
6. Bridge rewrites tool names and returns local MCP tool definitions.

### Tool call flow

1. OpenClaw runtime calls local rewritten tool name.
2. Bridge resolves stored routing metadata for that local tool.
3. Bridge refreshes auth if needed using OpenClaw's auth runtime.
4. Bridge calls remote `tools/call` against `codex_apps`.
5. Bridge passes the result back through the normal MCP result path.

## File Plan

- `src/plugins/types.ts`
  Add native managed MCP server registration types if not already present.

- `src/plugins/registry.ts`
  Store managed MCP server registrations in the active plugin registry.

- `src/agents/embedded-pi-mcp.ts`
  Merge managed MCP servers alongside bundle MCP and top-level `mcp.servers`.

- `src/agents/pi-project-settings.ts`
  Carry managed MCP servers into embedded Pi settings snapshots.

- `src/agents/cli-runner/bundle-mcp.ts`
  Extend the current CLI MCP merge path to include managed MCP servers.

- `extensions/openai/openclaw.plugin.json`
  Add `chatgptApps` config schema and UI hints.

- `extensions/openai/index.ts`
  Register the managed local ChatGPT apps MCP bridge when enabled.

- `extensions/openai/chatgpt-apps/app-server-supervisor.ts`
  Spawn, monitor, and reconnect the `codex app-server` sidecar.

- `extensions/openai/chatgpt-apps/app-server-client.ts`
  Typed JSON-RPC client for `account/login/start`, `account/read`,
  `getAuthStatus`, and `app/list`.

- `extensions/openai/chatgpt-apps/auth-projector.ts`
  Resolve OpenClaw `openai-codex` auth and project it into the sidecar through
  `chatgptAuthTokens`.

- `extensions/openai/chatgpt-apps/sidecar-config.ts`
  Build and update the isolated Codex config derived from OpenClaw connector
  enablement.

- `extensions/openai/chatgpt-apps/inventory.ts`
  Own `app/list` pagination, caching, and `app/list/updated` handling.

- `extensions/openai/chatgpt-apps/remote-codex-apps-client.ts`
  Call the remote `codex_apps` MCP endpoint using the same URL derivation rules
  Codex uses.

- `extensions/openai/chatgpt-apps/mcp-bridge.ts`
  Local stdio MCP server that rewrites names, filters by current inventory, and
  forwards `tools/call`.

- `src/cli/mcp-cli.ts` or a nearby MCP CLI entrypoint
  Add an internal entrypoint such as `openclaw mcp openai-chatgpt-apps`.

- `src/plugins/status.ts`
  Report sidecar status, current account projection state, and app availability
  diagnostics.

## Milestones

### Milestone 1: Sidecar + projected auth + inventory

**Shipped functionality:** OpenClaw can run a Codex app-server sidecar, project
its current `openai-codex` login into it, and show authoritative app inventory
and diagnostics.

Tasks:

- add sidecar supervisor
- add external auth projection via `chatgptAuthTokens`
- implement paginated `app/list`
- wire `app/list/updated`
- add diagnostics for:
  - no auth
  - missing account id
  - sidecar missing or incompatible
  - no accessible apps

Verification:

- `app/list` returns stable `AppInfo[]`
- inventory updates after auth projection
- config changes update `AppInfo.isEnabled` in the next snapshot

### Milestone 2: Local MCP bridge for already-linked apps

**Shipped functionality:** Accessible and locally enabled ChatGPT app tools are
available inside OpenClaw sessions as normal MCP tools.

Tasks:

- add managed MCP server registration
- implement local stdio bridge
- implement remote `codex_apps` tool fetch and tool call forwarding
- rewrite names and preserve routing metadata
- filter tools using current inventory snapshot

Verification:

- enabled, accessible connectors expose tools in embedded Pi and supported CLI
  backends
- tool calls succeed end-to-end through the normal OpenClaw tool runner
- locally disabled connectors do not expose tools

### Milestone 3: Polish and operator controls

**Shipped functionality:** Operators can control launch strategy, inspect sidecar
status, and understand failure causes without reading logs.

Tasks:

- add `appServer.command` and `chatgptBaseUrl` advanced config
- improve `plugins inspect openai` and status output
- add explicit hard refresh support
- document the feature and the Codex runtime prerequisite

Verification:

- operator can override the `codex` binary location
- diagnostics identify whether a failure is auth, sidecar, inventory, or remote
  MCP related

### Milestone 4: Connect flow parity

**Shipped functionality:** OpenClaw can initiate connector link flows rather
than only consuming already-linked connectors.

Tasks:

- confirm the source-backed link/install flow contract
- add operator-facing connect UX
- refresh inventory after link completion

Verification:

- linking a connector from OpenClaw makes it appear in the inventory and tool
  surface without restarting the gateway

## Risks And Mitigations

1. **Codex binary dependency**
   OpenClaw now depends on a compatible `codex app-server` binary.
   Mitigation: explicit command override, startup handshake, and clear
   diagnostics when the binary is missing or incompatible.

2. **Protocol drift between OpenClaw and Codex**
   `app/list` and login payloads may evolve.
   Mitigation: use generated app-server types where possible and gate the
   feature behind a runtime compatibility check.

3. **External auth does not self-refresh in the sidecar**
   The app-server generated docs explicitly say external auth refresh must be
   handled by the client.
   Mitigation: OpenClaw remains the only refresh owner and re-projects auth
   before inventory/tool refreshes.

4. **Wrong apps base URL derivation**
   Reusing the model base URL would derive the wrong apps endpoint.
   Mitigation: introduce a separate `chatgptBaseUrl` and follow Codex's own
   derivation rules.

5. **Tool surface still requires a local bridge**
   The app-server RPC surface does not provide generic app-tool list/call
   methods.
   Mitigation: keep the bridge minimal and use app-server only for the parts it
   actually owns.

6. **Config drift between OpenClaw and the sidecar**
   If the sidecar reads unrelated Codex config, `AppInfo.isEnabled` may not mean
   what OpenClaw thinks it means.
   Mitigation: run the sidecar inside an OpenClaw-owned runtime/config sandbox.

## Open Questions

1. What is the minimum supported Codex binary version that guarantees:
   - `chatgptAuthTokens` login
   - `app/list`
   - `app/list/updated`

2. What is the cleanest OpenClaw-owned runtime directory strategy for the
   sidecar: one shared gateway-level sandbox or one sandbox per agent/workspace
   scope?

3. Should OpenClaw ever let the bridge read the projected token back from
   `getAuthStatus(includeToken=true)`, or should all remote calls always use the
   OpenClaw auth resolver directly?

4. Do we want per-session app gating in OpenClaw later, and if so should that
   remain OpenClaw-owned or map onto app-server `threadId` semantics?

5. Should first-party OpenClaw support replace or coexist with the community
   `openclaw-codex-app-server` plugin, which solves a different
   conversation-binding problem today?

## Appendix

Source material reviewed for this design:

- `0/notes/packages/codex/flows/topic.chatgpt-apps-auth-exposure.md`
- `0/notes/packages/codex/flows/ref.codex-apps-app-list-loading.md`
- `codex-apps/app-server-types/src/v2/LoginAccountParams.ts`
- `codex-apps/app-server-types/src/v2/AppsListParams.ts`
- `codex-apps/app-server-types/src/v2/AppInfo.ts`
- `codex-apps/app-server-types/src/GetAuthStatusParams.ts`
- `codex-apps/app-server-types/src/v2/GetAccountParams.ts`
- `docs/flows/ref.chatgpt-login.md`

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-03-26: Replaced the native-bridge-only draft with an app-server-based design that uses `codex app-server` for auth projection and app inventory, while keeping a small local MCP bridge because OpenClaw is stdio-only for managed MCP today. (019d2b6c-1264-7ed1-8a59-e79dcf6c703c)
