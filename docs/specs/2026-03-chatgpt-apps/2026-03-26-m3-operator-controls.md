# Feature Spec: ChatGPT Apps Milestone 3 - Operator Controls and Diagnostics

**Date:** 2026-03-26
**Status:** Planning

---

## Goal and Scope

### Goal

Make the ChatGPT apps integration operable without log-diving by adding explicit
configuration controls, refresh controls, and diagnostics to existing OpenClaw
status and plugin-inspection surfaces.

### In Scope

- Add advanced OpenAI-plugin config for ChatGPT apps sidecar launch and apps URL
  overrides.
- Improve `openclaw plugins inspect openai`, `openclaw status`, and related
  read-only diagnostic surfaces for ChatGPT apps state.
- Add an explicit hard-refresh path that forces auth re-projection and
  inventory/tool refresh.
- Document the feature, runtime prerequisite, and operator troubleshooting path.

### Out of Scope

- Connector linking or install flows.
- Replacing the Milestone 1 or 2 control-plane and bridge contracts.
- New generic plugin framework surfaces unrelated to ChatGPT apps.
- Hidden log-only debugging workflows as the primary support path.

---

## Context and Constraints

### Background

Milestones 1 and 2 establish the sidecar, inventory, and MCP bridge. That is
not enough for real operators unless they can inspect current state, override
binary or URL assumptions when their environment differs, and force a clean
refresh when external auth or remote app state changes.

### Current State

OpenClaw already has:

- `openclaw status`, `status --all`, and `status --deep` as read-only
  diagnostic surfaces
- `openclaw plugins inspect <id>` as a deep plugin introspection surface
- plugin config schema and plugin-specific diagnostics plumbing

The ChatGPT apps design already calls out:

- `plugins.entries.openai.config.chatgptApps.appServer.command`
- `plugins.entries.openai.config.chatgptApps.chatgptBaseUrl`
- explicit hard refresh support
- failure classification across auth, sidecar, inventory, and remote MCP

### Required Pre-Read

- `docs/specs/2026-03-chatgpt-apps/design.md`
- `docs/specs/2026-03-chatgpt-apps/2026-03-26-m1-sidecar-auth-inventory.md`
- `docs/specs/2026-03-chatgpt-apps/2026-03-26-m2-local-mcp-bridge.md`
- `src/plugins/status.ts`
- `src/commands/status.command.ts`
- `src/cli/program/command-registry.ts`
- `docs/cli/plugins.md`
- `docs/cli/status.md`

### Constraints

- Primary diagnostics should live in commands operators already use instead of a
  parallel hidden workflow.
- Read-only status surfaces should remain safe to share, which means errors
  should be descriptive without leaking sensitive auth material.
- Config overrides must stay scoped to the ChatGPT apps feature and must not
  silently mutate the base `openai-codex` model transport assumptions.
- Hard refresh must coordinate Milestone 1 auth projection, inventory invalidation,
  and Milestone 2 tool publication so operators do not get mixed state.

### Non-obvious Dependencies or Access (Optional)

- The sidecar override path must work in environments where `codex` is not on
  `$PATH`, including managed installs or custom binary locations.
- Some operators may need a non-default ChatGPT base origin, so docs and
  validation should cover that override path explicitly.

---

## Approach and Touchpoints

### Proposed Approach

Treat Milestone 3 as an operability layer on top of the first two milestones:

1. Extend the OpenAI plugin config schema with advanced ChatGPT apps settings.
2. Emit a consolidated ChatGPT apps status snapshot from the integration
   service, including sidecar, auth projection, inventory freshness, bridge
   state, and last error classification.
3. Surface that snapshot in `plugins inspect openai` and relevant status
   commands.
4. Add a documented hard-refresh action that invalidates derived state,
   refreshes auth projection, refetches inventory, and rebuilds published tool
   state.
5. Update docs so operators know the runtime prerequisite, the primary
   diagnostic commands, and the override knobs.

The milestone should prefer extending existing surfaces over introducing a
separate one-off debug command unless a dedicated command is necessary for the
refresh action.

### Integration Points / Touchpoints

- `extensions/openai/openclaw.plugin.json`
  Add advanced config schema for `chatgptApps.appServer.command` and
  `chatgptApps.chatgptBaseUrl`.
- `extensions/openai/chatgpt-apps/diagnostics.ts`
  Consolidate typed status payloads for sidecar, auth, inventory, and bridge
  state.
- `extensions/openai/chatgpt-apps/inventory.ts`
  Provide refresh and freshness metadata.
- `extensions/openai/chatgpt-apps/mcp-bridge.ts`
  Expose bridge readiness and rebuild state after refresh.
- `src/plugins/status.ts`
  Extend plugin inspection/status reporting to include ChatGPT apps details for
  the OpenAI plugin.
- `src/commands/status.command.ts`
  Add read-only status rendering for the new diagnostics and any refresh hints.
- `src/cli/program/command-registry.ts`
  Wire any new internal refresh command or flag into the existing CLI command
  tree.
- `docs/cli/plugins.md`
  Document inspection behavior and any new refresh-capable inspection flag or
  related operator guidance.
- `docs/cli/status.md`
  Document status output additions and any deep-diagnostic guidance.

### Resolved Ambiguities / Decisions

- Operator-first surfaces: reuse `plugins inspect openai` and `status` as the
  main support path.
- Config scope: keep ChatGPT apps overrides under the OpenAI plugin config
  rather than global model transport config.
- Hard refresh semantics: refresh must coordinate auth projection, inventory,
  and tool publication rather than invalidating only one layer.
- Error taxonomy: status must explicitly distinguish auth, sidecar,
  inventory, and remote MCP failure categories.

### Important Implementation Notes (Optional)

- Refresh output should indicate whether the action actually re-projected auth
  and reloaded inventory or short-circuited because nothing was stale.
- Diagnostic rendering should include freshness timestamps or age summaries so
  operators can tell whether the snapshot is current.
- If a dedicated refresh command is introduced, it should still point operators
  back to `plugins inspect openai` or `status` for the post-refresh snapshot.

---

## Acceptance Criteria

- [ ] Operators can override the ChatGPT apps sidecar command and ChatGPT apps
      base URL through documented OpenAI-plugin config keys.
- [ ] `openclaw plugins inspect openai` and at least one status surface expose
      actionable ChatGPT apps diagnostics that distinguish auth, sidecar,
      inventory, and remote MCP states.
- [ ] Operators can trigger a documented hard refresh that re-projects auth,
      refetches inventory, and rebuilds published tool state without restarting
      the gateway.
- [ ] The feature documentation explains the `codex app-server` prerequisite,
      override knobs, and the recommended debug path.

---

## Phases and Dependencies

### Phase 1: Config schema and state model

- [ ] Extend the OpenAI plugin config schema with advanced ChatGPT apps fields.
- [ ] Define a consolidated status payload for the ChatGPT apps integration.
- [ ] Record freshness and last-error metadata needed for operator rendering.

### Phase 2: Inspection and status rendering

- [ ] Surface ChatGPT apps diagnostics in `plugins inspect openai`.
- [ ] Surface a summarized view in `status`, `status --all`, or `status --deep`
      as appropriate.
- [ ] Keep output safe for pasteable diagnostics and JSON consumers.

### Phase 3: Hard refresh control

- [ ] Add a CLI-visible hard-refresh action or flag on an existing command.
- [ ] Coordinate refresh across sidecar auth projection, inventory invalidation,
      and bridge/tool publication.
- [ ] Report refresh outcome clearly to the operator.

### Phase 4: Documentation and troubleshooting

- [ ] Update CLI docs for plugin inspection and status.
- [ ] Document the `codex` runtime prerequisite and override behavior.
- [ ] Add troubleshooting guidance for the four major failure classes.

### Phase Dependencies

- Phase 2 depends on the state payload from Phase 1.
- Phase 3 depends on the Milestone 1 and 2 services exposing explicit refresh
  hooks and readiness state.
- Phase 4 depends on the final operator surfaces from Phases 2 and 3.
- Milestone 4 should reuse the same status and refresh pathways when connector
  linking changes inventory state.

---

## Validation Plan

Integration tests:

- Add a config-schema integration test that verifies the new advanced ChatGPT
  apps config keys parse and normalize correctly.
- Add a plugin-inspect integration test that verifies `openclaw plugins inspect
openai --json` includes the expected ChatGPT apps state payload.
- Add a status rendering integration test that verifies the summarized ChatGPT
  apps diagnostics appear in the intended status command output.
- Add a hard-refresh integration test that confirms auth re-projection,
  inventory invalidation, and bridge rebuild all occur on one operator action.

Unit tests (Optional):

- Add unit tests for diagnostic severity mapping and status summarization.
- Add unit tests for freshness-age formatting or snapshot summarization logic.

Manual validation:

- Configure a custom `appServer.command` and verify OpenClaw uses it.
- Configure a custom `chatgptBaseUrl` and verify the apps integration uses it
  without affecting model transport behavior.
- Run the hard refresh action after changing local app enablement and verify the
  published tool set updates without a gateway restart.

---

## Done Criteria

- [ ] Operators have a documented and tested way to inspect ChatGPT apps state
      and force a refresh without reading logs.
- [ ] Advanced config overrides are implemented, validated, and documented.
- [ ] The milestone 1-3 spec set stays aligned on status terminology and
      refresh semantics.

---

## Open Items and Risks

### Open Items

- [ ] Decide whether hard refresh belongs on `plugins inspect openai`, `status`,
      or a dedicated internal subcommand.
- [ ] Decide how much per-app detail should appear in human-readable status
      output versus JSON-only inspection.
- [ ] Confirm whether docs should treat custom `chatgptBaseUrl` as advanced-only
      or include it in normal setup guidance.

### Risks and Mitigations

| Risk                                                                         | Impact | Probability | Mitigation                                                                                                 |
| ---------------------------------------------------------------------------- | ------ | ----------- | ---------------------------------------------------------------------------------------------------------- |
| Status output becomes too noisy or too vague to diagnose real issues         | Med    | Med         | Keep a summarized human view plus a richer JSON inspect payload                                            |
| Hard refresh only updates one layer and leaves operators with mixed state    | High   | Med         | Implement refresh as one orchestrated integration action with tests across all layers                      |
| Config overrides accidentally affect `openai-codex` model transport behavior | High   | Low         | Keep apps overrides under a separate ChatGPT apps config path and test transport isolation                 |
| Diagnostic messages leak auth-sensitive information                          | High   | Low         | Reuse existing read-only status safety rules and restrict output to classification plus freshness metadata |

### Simplifications and Assumptions (Optional)

- This milestone assumes existing CLI surfaces are sufficient for operator
  visibility unless refresh actions prove too awkward to attach there.
- This milestone assumes JSON inspection can carry more detail than the default
  human-readable output.

---

## Outputs

- PR created from this spec: Not started

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-03-26: Created milestone 3 execution plan for operator controls, diagnostics, and refresh behavior. (019d2b82-77db-7072-9814-fc41a5c45062)
