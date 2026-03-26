# Feature Spec: ChatGPT Apps Milestone 2 - Local MCP Bridge for App Tools

**Date:** 2026-03-26
**Status:** Planning

---

## Goal and Scope

### Goal

Expose already-linked, locally enabled ChatGPT app tools inside OpenClaw
sessions as ordinary MCP tools by adding a local stdio bridge that translates
between OpenClaw's MCP runtime and the remote `codex_apps` tool surface.

### In Scope

- Add an OpenClaw-owned local stdio MCP bridge for ChatGPT apps.
- Reuse Milestone 1 sidecar and inventory state as the authority for which apps
  are accessible and enabled.
- Fetch remote tool definitions from the ChatGPT `codex_apps` MCP surface.
- Rewrite remote tool names into an OpenClaw-safe local namespace while
  preserving enough metadata to route calls back to the remote tool.
- Forward `tools/list` and `tools/call` through the bridge.
- Register the bridge through existing embedded Pi and supported CLI MCP
  injection seams.

### Out of Scope

- Connector linking or install flows.
- A remote HTTP MCP mount path in OpenClaw core.
- Non-stdio managed MCP registration surfaces beyond the current embedded Pi and
  supported CLI backends.
- Milestone 3 operator hard refresh, custom binary overrides, or extra
  diagnostics beyond what is required for bridge correctness.

---

## Context and Constraints

### Background

The design doc establishes that Codex app-server is the right control plane for
auth projection and inventory, but not the final tool-execution interface.
OpenClaw's current managed MCP support is local stdio-oriented, while the
ChatGPT app tools still live behind the synthetic `codex_apps` MCP endpoint.
Milestone 2 bridges that gap.

### Current State

After Milestone 1, OpenClaw is expected to have:

- a sidecar supervisor and projected-auth flow
- authoritative `AppInfo[]` inventory snapshots
- diagnostics that distinguish auth, compatibility, and empty-inventory states

OpenClaw already has:

- `loadEmbeddedPiMcpConfig(...)`, which merges plugin-owned MCP config into
  embedded Pi settings
- `prepareCliBundleMcpConfig(...)`, which injects strict MCP config into
  supported CLI backends
- `openclaw mcp` CLI plumbing for configured MCP servers

OpenClaw does not yet have:

- a plugin-owned MCP bridge process for ChatGPT apps
- a remote apps client that can fetch `codex_apps` tools and forward tool calls
- a naming/routing scheme that maps remote app tools into stable local MCP tool
  names

### Required Pre-Read

- `docs/specs/2026-03-chatgpt-apps/design.md`
- `docs/specs/2026-03-chatgpt-apps/2026-03-26-m1-sidecar-auth-inventory.md`
- `docs/plugins/architecture.md`
- `src/plugins/bundle-mcp.ts`
- `src/agents/embedded-pi-mcp.ts`
- `src/agents/pi-project-settings.ts`
- `src/agents/cli-runner/bundle-mcp.ts`
- `src/cli/mcp-cli.ts`

### Constraints

- OpenClaw still only has local stdio MCP injection for plugin-owned managed MCP
  servers; Milestone 2 must fit that shape.
- Tool availability must be filtered by the latest Milestone 1 inventory
  snapshot so inaccessible or locally disabled apps do not leak tools.
- Remote tool names may collide across apps or with existing local tools, so the
  bridge must generate stable rewritten names.
- Tool calls must retain enough routing metadata to reach the correct remote app
  tool without relying on ambiguous display names.
- Supported CLI coverage must match existing bundle MCP capabilities; current
  source shows explicit CLI bundle-MCP injection support only for `claude-cli`.

### Non-obvious Dependencies or Access (Optional)

- The remote apps endpoint must be reachable with the same account-bound auth
  semantics used by `openai-codex`.
- The bridge depends on the Milestone 1 control plane being healthy; if
  inventory or auth is degraded, the bridge should fail closed instead of
  emitting stale tools.

---

## Approach and Touchpoints

### Proposed Approach

Add a local bridge process that behaves like a normal stdio MCP server from
OpenClaw's perspective while acting as a remote client behind the scenes.

At a high level:

1. OpenClaw starts the bridge as a managed local stdio MCP server.
2. The bridge reads the latest inventory snapshot from the Milestone 1 service.
3. The bridge fetches the remote `codex_apps` tool list with projected auth and
   correct apps-base URL derivation.
4. The bridge filters tools to only those belonging to currently accessible and
   enabled apps.
5. The bridge rewrites tool names into a collision-safe local namespace and
   stores routing metadata.
6. On `tools/call`, the bridge maps the local name back to the original remote
   tool and forwards the request.

The bridge should fail closed: if inventory cannot be trusted, it should avoid
surfacing tools rather than expose stale or unauthorized app tools.

### Integration Points / Touchpoints

- `src/plugins/bundle-mcp.ts`
  Existing plugin-owned MCP config loading path that will need a generated
  server entry for the ChatGPT apps bridge.
- `src/agents/embedded-pi-mcp.ts`
  Embedded Pi MCP merge point that should receive the new bridge server config.
- `src/agents/pi-project-settings.ts`
  Embedded Pi settings snapshot builder that needs the new bridge registration
  to flow into `mcpServers`.
- `src/agents/cli-runner/bundle-mcp.ts`
  Supported CLI backend injection seam; current source limits this to
  `claude-cli`, which should be called out explicitly in implementation.
- `src/cli/mcp-cli.ts`
  Existing MCP CLI surface and likely home for an internal bridge-specific
  command or status aid.
- `extensions/openai/chatgpt-apps/inventory.ts`
  Milestone 1 inventory source of truth that the bridge should consume.
- `extensions/openai/chatgpt-apps/remote-codex-apps-client.ts`
  New remote client for tool discovery and tool execution against `codex_apps`.
- `extensions/openai/chatgpt-apps/mcp-bridge.ts`
  New local stdio MCP bridge implementation.
- `extensions/openai/chatgpt-apps/tool-registry.ts`
  New local name-rewrite and routing-metadata registry.
- `extensions/openai/chatgpt-apps/server-entry.ts`
  New process entrypoint used by the managed MCP server config.

### Resolved Ambiguities / Decisions

- Bridge shape: use a local stdio MCP server because OpenClaw's existing managed
  MCP integration is stdio-oriented.
- Tool gating: filter by Milestone 1 inventory snapshots instead of trusting the
  remote tool list alone.
- Failure mode: fail closed when inventory/auth state is unavailable or stale.
- CLI scope: target embedded Pi plus the current bundle-MCP-supported CLI
  backend(s), with `claude-cli` explicitly covered by current code.
- Name mapping: keep a stable local rewrite plus explicit metadata rather than
  deriving routing from a human-readable display name at call time.

### Important Implementation Notes (Optional)

- The bridge's local names should remain deterministic across restarts so agent
  tool planning does not churn.
- When routing responses internally, preserve enough provider or app-scoped
  namespacing to avoid mixed response IDs if multiple remote requests are in
  flight.
- The bridge should not block on full inventory refetch for every `tools/list`
  request when a fresh snapshot is already available.

---

## Acceptance Criteria

- [ ] Embedded Pi can see ChatGPT app tools through a local stdio MCP bridge
      when those apps are both accessible in inventory and locally enabled.
- [ ] Supported CLI backends that already consume bundle MCP config can also see
      the same bridge-exposed tools.
- [ ] Locally disabled or inaccessible apps do not expose tools through the
      bridge even if the remote `codex_apps` endpoint returns them.
- [ ] Rewritten local tool names are stable and collision-safe, and tool calls
      route back to the correct remote app tool end to end.
- [ ] Bridge failures caused by missing auth, unhealthy inventory, or remote
      call errors are surfaced as actionable MCP/runtime errors rather than
      silent tool disappearance or misrouting.

---

## Phases and Dependencies

### Phase 1: Remote tool client and bridge protocol

- [ ] Implement a remote `codex_apps` client for tool discovery and tool
      invocation.
- [ ] Define the bridge's local routing metadata model and collision-safe name
      rewrite scheme.
- [ ] Add a stdio MCP server entrypoint for local process startup.

### Phase 2: Inventory-filtered tool publication

- [ ] Connect the bridge to Milestone 1 inventory snapshots.
- [ ] Filter remote tools by app accessibility and local enablement.
- [ ] Cache or memoize the rewritten tool registry for stable `tools/list`
      responses.

### Phase 3: Tool execution routing

- [ ] Map local tool calls back to the original remote tool identifier.
- [ ] Forward arguments and normalize remote responses into MCP-compatible
      results.
- [ ] Handle transport, auth, and remote-tool execution errors without leaking
      stale routing state.

### Phase 4: OpenClaw runtime registration

- [ ] Register the bridge as plugin-owned managed MCP config for embedded Pi.
- [ ] Wire the same config into supported CLI bundle-MCP injection.
- [ ] Add an internal CLI or status surface to inspect bridge configuration and
      availability.

### Phase Dependencies

- Phase 2 depends on Milestone 1 inventory semantics and the client/routing
  primitives from Phase 1.
- Phase 3 depends on the registry created in Phase 2.
- Phase 4 depends on a working bridge process and end-to-end tool routing from
  Phases 1 through 3.
- Milestone 3 should reuse the bridge diagnostics and refresh hooks introduced
  here rather than creating a second control path.

---

## Validation Plan

Integration tests:

- Add an end-to-end embedded Pi integration test that injects the bridge MCP
  server, exposes a filtered tool list, and exercises a successful remote tool
  call.
- Add a supported CLI backend integration test for bundle MCP injection using
  the generated bridge server config.
- Add an inventory-filter integration test that proves disabled or inaccessible
  apps do not surface their tools locally.
- Add a collision test where multiple remote tools would conflict without name
  rewriting and verify the local names stay unique and stable.
- Add a tool-routing integration test that confirms the bridge forwards a local
  tool call to the correct remote identifier and preserves response integrity.

Unit tests (Optional):

- Add unit tests for local-name generation and reverse-lookup metadata.
- Add unit tests for stale-registry invalidation when inventory changes.

Manual validation:

- Start an OpenClaw session with at least one linked app and confirm the tool
  appears in the agent tool list.
- Disable that app locally and verify the next session or refresh no longer
  shows the tool.
- Force a remote tool error and verify the surfaced failure is routed through
  normal OpenClaw tool error handling.

---

## Done Criteria

- [ ] The bridge process, remote client, and managed MCP registration all land
      with coverage for tool listing, filtering, and execution.
- [ ] Embedded Pi and current supported CLI bundle-MCP backends can both use
      the bridge successfully.
- [ ] Milestone 1 inventory and Milestone 2 tool publication semantics are
      documented consistently across the spec set.

---

## Open Items and Risks

### Open Items

- [ ] Confirm the exact remote endpoint contract for `tools/list` and
      `tools/call` against `codex_apps`, including whether tool schemas are
      fully static or need periodic refresh.
- [ ] Decide whether the local rewrite format should encode app id, plugin
      display name, or both for operator readability.
- [ ] Confirm whether OpenClaw needs a dedicated internal command to run the
      bridge directly for debugging, or whether status inspection is sufficient.

### Risks and Mitigations

| Risk                                                                                       | Impact | Probability | Mitigation                                                                                                             |
| ------------------------------------------------------------------------------------------ | ------ | ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| Remote tool names collide across apps or with existing local tools                         | High   | Med         | Use a deterministic rewrite scheme plus reverse-lookup metadata and cover it with collision tests                      |
| Inventory and remote tool list drift, causing stale or unauthorized local tools            | High   | Med         | Filter every published registry through the latest inventory snapshot and invalidate on inventory updates              |
| Tool-call routing loses the original remote identifier and sends the call to the wrong app | High   | Low         | Store explicit routing metadata per published local tool instead of reconstructing it heuristically                    |
| Supported CLI backends diverge from embedded Pi behavior                                   | Med    | Med         | Keep bundle-MCP registration in one generated config path and test both embedded Pi and current supported CLI backends |

### Simplifications and Assumptions (Optional)

- This milestone assumes bridge state can live in memory for the process
  lifetime; durable caching is deferred unless profiling shows it is needed.
- This milestone assumes current supported CLI injection remains limited to the
  bundle-MCP path already present in core.

---

## Outputs

- PR created from this spec: Not started

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-03-26: Created milestone 2 execution plan for the local ChatGPT apps MCP bridge. (019d2b82-77db-7072-9814-fc41a5c45062)
