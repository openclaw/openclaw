# Feature Spec: Native Plugin registerMcpServer

**Date:** 2026-04-05
**Status:** In Progress

---

## Goal and Scope

### Goal

Add a native `registerMcpServer` surface to the plugin SDK so trusted native plugins can register managed MCP servers that OpenClaw injects into embedded runs without relying on bundle-only `.mcp.json` files or ad hoc provider-specific tool wiring.

### In Scope

- Add a new native plugin API for managed stdio MCP server registration.
- Persist native-plugin MCP registrations in the plugin registry and capture/testing helpers.
- Merge native-plugin MCP registrations into the embedded MCP config/runtime used by tool-enabled embedded runs.
- Add proof coverage with a dummy native plugin that exposes a hello-world MCP server.
- Validate the proof by installing the plugin in dev and exercising the server path.

### Out of Scope

- Remote HTTP/SSE registration for native plugins in the initial seam.
- Remote MCP transport redesign beyond the existing transport support.
- Bundle/plugin manifest changes for third-party bundle layouts.
- Dynamic enable/disable policy beyond what native plugins can already express through runtime/config data at registration time.

---

## Context

### Background

Issue `#57355` asks for a first-class native-plugin seam that lets plugins project dynamic MCP-backed capability inventories into embedded OpenAI-backed runs. Today OpenClaw already knows how to launch and materialize MCP tools for embedded sessions, but that path only consumes bundle `.mcp.json` plus operator-managed config.

### Current State

Embedded runs call `getOrCreateSessionMcpRuntime()` and `materializeBundleMcpToolsForRun()` to inject MCP tools into the tool list. That runtime loads config from `loadEmbeddedPiMcpConfig()`, which currently merges bundle-provided `.mcp.json` entries with `config.mcp.servers`. Native plugins have no equivalent registration hook, so trusted plugin code cannot join the same runtime path.

### Context

- [src/plugins/types.ts](src/plugins/types.ts): native plugin API surface and registration type definitions.
- [src/plugins/api-builder.ts](src/plugins/api-builder.ts): default/no-op API surface used by loader/setup/captured registration paths.
- [src/plugins/registry.ts](src/plugins/registry.ts): authoritative runtime registry that records plugin-owned registrations.
- [src/plugins/captured-registration.ts](src/plugins/captured-registration.ts): capture helper that must expose the same registration surface to tests and SDK utilities.
- [src/agents/embedded-pi-mcp.ts](src/agents/embedded-pi-mcp.ts): merge point for MCP server config used by embedded runs.
- [src/agents/pi-bundle-mcp-runtime.ts](src/agents/pi-bundle-mcp-runtime.ts): session runtime that launches MCP servers and catalogs tools.
- [src/agents/pi-embedded-runner/run/attempt.ts](src/agents/pi-embedded-runner/run/attempt.ts): embedded-run path where MCP tools are materialized into the effective tool list.
- [src/plugins/bundle-mcp.ts](src/plugins/bundle-mcp.ts): current MCP config normalization logic that can be reused for server config shape/normalization.

### Constraints

- Keep the seam native-plugin-only; do not leak plugin internals into core outside the plugin SDK contract.
- Preserve deterministic MCP tool ordering and prompt-cache stability.
- Reuse the existing embedded MCP runtime instead of creating a parallel plugin-specific launcher.
- Keep operator-managed `config.mcp.servers` as the highest-precedence owner-managed override layer.

---

## Approach and Touchpoints

### Proposed Approach

Introduce a `registerMcpServer` API that accepts a plugin-owned server name plus a managed stdio MCP server config (`command`, optional `args`, `env`, `cwd`, and timeout metadata). Store these registrations in the plugin registry, then pass an explicit native-plugin server snapshot into `loadEmbeddedPiMcpConfig()` so embedded runs do not depend on hidden global state. The existing embedded session runtime can then launch those servers alongside bundle/config servers through the current MCP catalog/materialization path. Dynamic capability inventory stays inside the MCP server after launch; Phase 1 does not add per-session resolver callbacks. Add tests for registration capture, merge precedence, duplicate detection, and end-to-end materialization. Prove the seam with a small dev plugin whose MCP server exposes a single `hello_world` tool returning `hi human`.

### Integration Points / Touchpoints

- `src/plugins/types.ts`: define the MCP registration types and add `registerMcpServer` to `OpenClawPluginApi`.
- `src/plugins/api-builder.ts`: add the new handler slot and noop implementation.
- `src/plugins/registry.ts`: record plugin-owned MCP registrations and expose them through the registry.
- `src/plugins/registry-empty.ts`: initialize the new registry collection.
- `src/plugins/captured-registration.ts` and tests: keep capture helpers aligned with the new API surface.
- `src/agents/embedded-pi-mcp.ts`: accept an explicit native-plugin MCP snapshot and merge it with existing bundle/config layers.
- `src/agents/pi-bundle-mcp-runtime.test.ts` and adjacent tests: prove the runtime sees native-plugin registrations.
- `extensions/*` new dummy plugin: provide the proof plugin and server implementation.

### Resolved Ambiguities / Decisions

- Registration shape for Phase 1 is managed stdio only, even though the underlying runtime also supports HTTP/SSE from bundle/config layers.
- Native-plugin MCP registrations will be session-managed, not long-lived plugin services; the existing embedded runtime already owns connect/list/call/dispose behavior.
- Native-plugin MCP registrations are passed into `loadEmbeddedPiMcpConfig()` as an explicit snapshot rather than being looked up from a process-global registry inside the embedded runtime.
- Merge precedence will stay `bundle defaults < native plugin registrations < operator config` so operators can still override or disable conflicting names.
- Duplicate native-plugin server names will be deterministic: first registration wins, later duplicates are skipped with plugin-attributed diagnostics.
- Dynamic runtime/account-specific capability changes are expected to happen inside the launched MCP server's `listTools` and tool behavior, not via per-session registration callbacks in Phase 1.
- Proof will target the embedded tool runtime by making the dummy plugin installable in dev and verifying the resulting materialized MCP tool answers with `hi human`.

### Important Implementation Notes

- Tool and server ordering must remain deterministic; any merge of native-plugin servers must use stable iteration and avoid order-dependent collisions where possible.
- Native plugin registrations should include plugin ownership metadata so diagnostics remain attributable.
- The proof should call the materialized MCP tool deterministically rather than relying on an LLM to decide to use it from natural-language prompting.

---

## Acceptance Criteria

- [ ] A native plugin can call `api.registerMcpServer(...)` during registration without using bundle `.mcp.json`.
- [ ] Embedded runs include native-plugin MCP servers in the same managed runtime path used for existing bundle/config MCP servers.
- [ ] Operator-managed `config.mcp.servers` still overrides plugin defaults when names collide.
- [ ] Duplicate native-plugin server names produce deterministic diagnostics and do not create order-dependent runtime behavior.
- [ ] A dummy native plugin installed in dev can expose a hello-world MCP capability that returns `hi human`.

---

## Phases and Dependencies

### Phase 1: Add the SDK and registry seam

- [ ] Add MCP server registration types and API surface.
- [ ] Persist native-plugin MCP registrations in the runtime registry and capture helpers.
- [ ] Define deterministic duplicate-name handling and diagnostics.
- [ ] Add focused unit tests for the new API surface.

### Phase 2: Wire native-plugin MCP into embedded runs

- [ ] Extend embedded MCP config loading to accept and merge an explicit native-plugin MCP snapshot.
- [ ] Add runtime tests covering merge precedence and tool materialization.

### Phase 3: Proof plugin and dev validation

- [ ] Add a dummy native plugin plus tiny MCP server implementation.
- [ ] Install/enable the plugin in a dev workspace path.
- [ ] Exercise the hello-world flow and capture proof output.

### Phase Dependencies

- Phase 2 depends on the registry seam from Phase 1.
- Phase 3 depends on the runtime merge path from Phase 2.

---

## Validation Plan

Integration tests:

- Add/extend plugin registration tests to verify `registerMcpServer` is available and captures server definitions.
- Add/extend embedded MCP runtime tests to verify native-plugin servers are loaded, duplicate names are handled deterministically, and tools are materialized into the run.
- Add a proof-oriented test or harness that calls the materialized dummy plugin MCP tool and asserts the returned text is `hi human`.

Manual validation:

- Install the dummy plugin in dev.
- Run a targeted OpenClaw dev command or harness that materializes embedded MCP tools with the dummy plugin enabled.
- Call the resulting hello-world MCP tool directly and confirm the returned text is `hi human`.

---

## Done Criteria

- [ ] The native plugin SDK seam, registry wiring, and embedded runtime merge are implemented.
- [ ] Automated validation covers the new registration and runtime behavior.
- [ ] The dummy plugin proof works in dev and the proof steps/results are recorded in the final handoff.

---

## Open Items and Risks

### Open Items

- [ ] Confirm whether follow-up work should add per-session server config resolvers for plugins that need runtime-specific launch arguments. Phase 1 assumes static launch config and dynamic tool inventory inside the server.

### Risks and Mitigations

| Risk                                                                           | Impact | Probability | Mitigation                                                                                                      |
| ------------------------------------------------------------------------------ | ------ | ----------- | --------------------------------------------------------------------------------------------------------------- |
| Native-plugin registrations bypass existing MCP normalization assumptions      | High   | Med         | Reuse the same server-config normalization and transport resolution paths already used by bundle/config servers |
| Name collisions create nondeterministic tool naming or override behavior       | High   | Med         | Keep explicit precedence, sort deterministically, and add tests for collisions/ordering                         |
| Proof plugin validates only the server in isolation, not the embedded run path | Med    | Med         | Drive the proof through the same embedded MCP runtime/tool materialization path used by production runs         |

### Simplifications and Assumptions

- The initial seam can treat native-plugin MCP servers as trusted plugin-owned defaults rather than adding per-server lifecycle callbacks.

---

## Outputs

- PR created from this spec: not started

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-04-05: Created the implementation spec for native plugin MCP registration. (019d613a-ac9c-77d0-991c-aec9aa14eacc - 33e77b435e)
- 2026-04-05: Tightened the spec around the explicit embedded-runtime seam, stdio-only Phase 1 scope, duplicate handling, and deterministic proof. (019d613a-ac9c-77d0-991c-aec9aa14eacc - 33e77b435e)
