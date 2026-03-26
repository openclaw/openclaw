# Feature Spec: ChatGPT Apps Milestone 1 - Sidecar, Projected Auth, and Inventory

**Date:** 2026-03-26
**Status:** Planning

---

## Goal and Scope

### Goal

Add the control-plane pieces required for ChatGPT apps in OpenClaw: supervise a
local Codex app-server sidecar, project the current `openai-codex` OAuth state
into that sidecar, and expose authoritative app inventory plus operator-facing
diagnostics without yet surfacing app tools in sessions.

### In Scope

- Launch and supervise a local `codex app-server` sidecar from the OpenAI plugin.
- Derive an OpenClaw-owned Codex runtime/config sandbox for the sidecar instead
  of using the user's normal `~/.codex`.
- Resolve and refresh the current `openai-codex` auth profile, including
  `chatgptAccountId`, then project it into the sidecar using
  `chatgptAuthTokens`.
- Implement paginated `app/list` reads plus `app/list/updated` invalidation.
- Mirror OpenClaw connector enablement into the derived Codex config so
  inventory snapshots report `AppInfo.isEnabled` correctly.
- Add status/diagnostic surfaces for auth, sidecar compatibility, and inventory
  emptiness.

### Out of Scope

- Exposing app tools as MCP tools inside embedded Pi or CLI sessions.
- Connector link/install initiation.
- Replacing OpenClaw's existing `openai-codex` auth storage or refresh logic.
- Sharing sidecar state with a separate Codex desktop install.

---

## Context and Constraints

### Background

The design doc establishes that OpenClaw should not reimplement ChatGPT app
directory behavior itself. Codex already has a local app-server that accepts
projected ChatGPT auth, owns `app/list` pagination and update notifications, and
merges directory state with connector access. OpenClaw already owns
`openai-codex` OAuth storage and refresh, so Milestone 1 is the seam where
those two systems meet.

### Current State

OpenClaw can:

- sign into `openai-codex` through browser OAuth and persist the credential in
  the auth profile store
- refresh provider-owned OAuth credentials through the existing auth runtime
- call Codex web endpoints with bearer auth plus `ChatGPT-Account-Id`
- inject local stdio MCP servers into embedded Pi and supported CLI backends

OpenClaw cannot yet:

- start or talk to a Codex app-server process
- project ChatGPT auth into an external auth consumer
- fetch or cache `AppInfo[]` inventory snapshots
- show ChatGPT-app-specific plugin diagnostics in `status` or `plugins inspect`

### Required Pre-Read

- `docs/specs/2026-03-chatgpt-apps/design.md`
- `docs/flows/ref.chatgpt-login.md`
- `docs/plugins/architecture.md`
- `src/plugins/provider-auth-choice.ts`
- `extensions/openai/openai-codex-provider.ts`
- `src/agents/auth-profiles/oauth.ts`
- `src/infra/provider-usage.fetch.codex.ts`
- `src/plugins/status.ts`

### Constraints

- OpenClaw remains the only refresh owner for `openai-codex`; the app-server's
  external auth mode does not proactively refresh projected credentials.
- `chatgptBaseUrl` for apps and directory APIs must remain independent from the
  `openai-codex` model transport base URL, which defaults to
  `https://chatgpt.com/backend-api`.
- The feature must not depend on or mutate the user's normal `~/.codex`
  runtime/config state.
- Diagnostics must be actionable from normal CLI surfaces instead of requiring
  log reading.
- Inventory behavior should work before any MCP bridge is introduced, so this
  milestone needs standalone status and inspection value.

### Non-obvious Dependencies or Access (Optional)

- The local machine must have a compatible `codex` binary that supports
  `app-server` plus the expected account and app RPC surface.
- Projected auth requires a usable `chatgptAccountId`; OAuth tokens without that
  identity cannot support inventory access.

---

## Approach and Touchpoints

### Proposed Approach

Add a new OpenAI-plugin-owned ChatGPT apps service that supervises a sidecar
process, writes an isolated Codex runtime/config snapshot derived from OpenClaw
state, and exposes an internal inventory client. The service should:

1. resolve the active `openai-codex` OAuth profile through the existing auth
   profile runtime
2. refresh it through the existing provider refresh path when needed
3. launch `codex app-server --analytics-default-enabled` inside an OpenClaw
   sandbox directory
4. call `account/login/start` with `type: "chatgptAuthTokens"`
5. call paginated `app/list`, cache the `AppInfo[]` snapshot, and invalidate on
   `app/list/updated`
6. report state through internal diagnostics consumed by `status` and plugin
   inspection surfaces

This milestone stops at inventory. It intentionally does not mount any MCP
bridge or session tool surface yet.

### Integration Points / Touchpoints

- `extensions/openai/openclaw.plugin.json`
  Add advanced config schema for ChatGPT apps sidecar settings and enablement.
- `extensions/openai/index.ts`
  Register any OpenAI-plugin-owned services or hooks needed to initialize the
  ChatGPT apps control plane.
- `extensions/openai/openai-codex-provider.ts`
  Remains the source of provider-level `openai-codex` OAuth semantics and
  account-bound transport assumptions.
- `src/plugins/provider-auth-choice.ts`
  Existing auth-entry seam that confirms how `openai-codex` credentials are
  created and stored.
- `src/agents/auth-profiles/oauth.ts`
  Existing refresh/runtime seam that should remain the only OAuth refresh owner.
- `src/infra/provider-usage.fetch.codex.ts`
  Current proof that OpenClaw already knows how to send bearer auth together
  with `ChatGPT-Account-Id`.
- `src/plugins/status.ts`
  Existing plugin inspection/status entrypoint for surfacing new diagnostics.
- `extensions/openai/chatgpt-apps/sidecar.ts`
  New process supervisor and RPC client transport.
- `extensions/openai/chatgpt-apps/auth-projector.ts`
  New auth projection helper that maps OpenClaw auth profile state into
  `chatgptAuthTokens`.
- `extensions/openai/chatgpt-apps/config-sandbox.ts`
  New helper that materializes an isolated Codex runtime/config snapshot.
- `extensions/openai/chatgpt-apps/inventory.ts`
  New inventory cache, pagination, and update subscription logic.
- `extensions/openai/chatgpt-apps/diagnostics.ts`
  New typed diagnostic model consumed by CLI surfaces.

### Resolved Ambiguities / Decisions

- Auth source of truth: OpenClaw auth profiles remain the root owner; the
  sidecar only receives projected external auth.
- Runtime isolation: the sidecar uses an OpenClaw-managed Codex sandbox instead
  of the user's normal `~/.codex`.
- Base URL handling: app inventory and remote apps config use an apps-specific
  `chatgptBaseUrl`, not the provider model `baseUrl`.
- Enablement source: `AppInfo.isEnabled` must reflect OpenClaw-managed config in
  the derived Codex sandbox.
- Milestone boundary: inventory and diagnostics ship before any tool exposure.

### Important Implementation Notes (Optional)

- The sandbox writer should be deterministic and easy to diff so hard-refresh
  behavior in Milestone 3 can reuse it.
- Sidecar supervision should key instances by workspace or agent scope plus the
  relevant config hash to avoid state bleed across different OpenClaw sessions.
- Inventory caching should separate "no accessible apps" from "inventory fetch
  failed" so operators do not get false negatives.

---

## Acceptance Criteria

- [ ] OpenClaw can launch a compatible `codex app-server` sidecar from the
      OpenAI plugin and keep its lifecycle scoped to OpenClaw-owned runtime
      state.
- [ ] With a valid `openai-codex` OAuth credential that includes
      `chatgptAccountId`, OpenClaw can project auth into the sidecar and fetch a
      stable `AppInfo[]` inventory snapshot through paginated `app/list`.
- [ ] Inventory snapshots refresh after projected auth changes and after
      `app/list/updated`, without requiring gateway restart.
- [ ] Inventory snapshots report `AppInfo.isEnabled` based on OpenClaw-managed
      connector enablement in the derived sandbox config.
- [ ] Operators can distinguish auth, missing-account-id, sidecar-compatibility,
      fetch-failure, and no-accessible-apps states through normal status
      surfaces.

---

## Phases and Dependencies

### Phase 1: Scaffold the control-plane module

- [ ] Add OpenAI-plugin config shape for ChatGPT apps control-plane settings.
- [ ] Create the `extensions/openai/chatgpt-apps/` module set with sidecar,
      auth, sandbox, inventory, and diagnostics seams.
- [ ] Define typed internal results for sidecar compatibility, auth projection,
      and inventory snapshots.

### Phase 2: Sidecar supervision and auth projection

- [ ] Implement sidecar process startup, handshake, restart, and teardown.
- [ ] Resolve the active `openai-codex` OAuth credential from the auth profile
      store using existing runtime helpers.
- [ ] Project auth into the sidecar with `chatgptAuthTokens`, including
      `chatgptAccountId` and optional plan type metadata.

### Phase 3: Inventory cache and invalidation

- [ ] Implement paginated `app/list` reads and normalize them into an internal
      inventory snapshot.
- [ ] Subscribe to `app/list/updated` and invalidate or refresh cached results.
- [ ] Generate the derived Codex sandbox config so inventory reflects OpenClaw
      enablement.

### Phase 4: Diagnostics and operator surfaces

- [ ] Surface typed diagnostics through plugin status or inspection flows.
- [ ] Add explicit error mapping for sidecar missing, protocol mismatch, auth
      unavailable, account id missing, and empty inventory.
- [ ] Ensure inventory status can be inspected even before MCP bridge work is
      implemented.

### Phase Dependencies

- Phase 2 depends on the control-plane module shape from Phase 1.
- Phase 3 depends on both sidecar connectivity and projected auth from Phase 2.
- Phase 4 depends on sidecar and inventory state models from Phases 2 and 3.
- Milestone 2 should depend on the inventory and diagnostics types defined here
  instead of re-deriving app availability.

---

## Validation Plan

Integration tests:

- Add a sidecar-supervisor integration test that verifies OpenClaw starts the
  configured `codex app-server` command, performs the expected handshake, and
  tears it down cleanly.
- Add an auth-projection integration test that stubs an `openai-codex` auth
  profile, refreshes it through the current runtime seam, and verifies the
  `chatgptAuthTokens` login payload sent to the sidecar.
- Add an inventory integration test that exercises paginated `app/list`
  aggregation into a stable `AppInfo[]` snapshot.
- Add an invalidation test that simulates `app/list/updated` and verifies the
  next inventory read returns a refreshed snapshot.
- Add a config-sandbox integration test that flips OpenClaw connector enablement
  and verifies the next inventory snapshot changes `AppInfo.isEnabled`.

Unit tests (Optional):

- Add unit tests for sandbox config generation and config-hash calculation.
- Add unit tests for diagnostic classification from sidecar, auth, and inventory
  error states.

Manual validation:

- Run the new inventory/status command path with a valid `openai-codex` login
  and verify accessible apps appear.
- Repeat with no `chatgptAccountId` and confirm the status surface reports the
  missing-account-id condition instead of a generic fetch failure.
- Point the config at an invalid `codex` binary and confirm the sidecar
  diagnostic is explicit and actionable.

---

## Done Criteria

- [ ] The Milestone 1 control-plane implementation lands with the required
      tests for sidecar startup, auth projection, inventory aggregation, and
      invalidation.
- [ ] Operator-facing diagnostics for the major failure states are wired into
      existing status or plugin inspection surfaces.
- [ ] The design doc and milestone follow-on specs remain aligned on the control
      plane contracts established here.

---

## Open Items and Risks

### Open Items

- [ ] Confirm the exact compatibility handshake or version probe OpenClaw should
      use before trusting the sidecar RPC surface.
- [ ] Decide whether inventory refresh should happen eagerly after every auth
      refresh or lazily on demand with freshness thresholds.
- [ ] Confirm whether plugin status should expose per-app detail directly or
      route operators to a dedicated internal subcommand.

### Risks and Mitigations

| Risk                                                                                              | Impact | Probability | Mitigation                                                                                                          |
| ------------------------------------------------------------------------------------------------- | ------ | ----------- | ------------------------------------------------------------------------------------------------------------------- |
| Codex app-server protocol drift breaks auth projection or inventory parsing                       | High   | Med         | Keep the RPC layer typed, gate the feature behind a compatibility check, and fail with explicit version diagnostics |
| OpenClaw refreshes `openai-codex` credentials but does not re-project them before inventory reads | High   | Med         | Make inventory reads depend on a fresh projection step or projection freshness marker                               |
| The derived Codex sandbox config drifts from OpenClaw enablement rules                            | Med    | Med         | Generate sandbox config from normalized OpenClaw config in one place and cover it with integration tests            |
| Empty inventories are misclassified as auth failures, making operators chase the wrong issue      | Med    | Med         | Keep separate result types for auth, fetch, compatibility, and empty-access states                                  |

### Simplifications and Assumptions (Optional)

- This milestone assumes a single sidecar scope per OpenClaw workspace or agent
  context is sufficient; cross-workspace sidecar sharing is deferred.
- This milestone assumes inventory consumers only need the latest snapshot, not
  a durable event log of directory changes.

---

## Outputs

- PR created from this spec: Not started

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-03-26: Created milestone 1 execution plan for ChatGPT apps sidecar, auth projection, and inventory work. (019d2b82-77db-7072-9814-fc41a5c45062)
