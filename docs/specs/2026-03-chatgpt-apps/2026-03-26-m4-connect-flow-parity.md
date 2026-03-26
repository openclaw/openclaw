# Feature Spec: ChatGPT Apps Milestone 4 - Connect Flow Parity

**Date:** 2026-03-26
**Status:** Planning

---

## Goal and Scope

### Goal

Allow OpenClaw to initiate ChatGPT app connector auth flows instead of only
consuming already-linked apps, then refresh local inventory and tool state when
linking completes.

### In Scope

- Add a source-backed operator-facing connect flow for ChatGPT apps that require
  auth.
- Reuse Codex's install and app-auth policy contracts where available.
- Launch app-auth browser flows from OpenClaw and observe completion.
- Refresh inventory and bridge-published tools after successful auth completion.
- Surface connect progress and failure states through the operator surfaces added
  in Milestone 3.

### Out of Scope

- Recreating Codex's full plugin marketplace UI in OpenClaw.
- General plugin marketplace work beyond the ChatGPT apps/connect flow needed by
  this feature.
- Changes to Milestones 1-3 control-plane contracts except where refresh hooks
  need to be reused.

---

## Context and Constraints

### Background

The first three milestones let OpenClaw consume already-linked apps and expose
their tools. Milestone 4 closes the remaining gap: when an app is installed or
present but not authorized, OpenClaw should be able to initiate the auth flow,
wait for completion, and publish the newly available tool surface without a
gateway restart.

### Current State

Source-backed Codex contracts already show:

- `plugin/install` returns `authPolicy` and `appsNeedingAuth`
- `mcpServer/oauth/login` returns an `authorizationUrl`
- `mcpServer/oauthLogin/completed` notifies the client when OAuth login
  succeeds or fails

OpenClaw currently has:

- browser-launch and remote/manual callback helpers for provider OAuth
- Milestone 1 projected auth and inventory
- Milestone 2 tool publication via local MCP bridge
- Milestone 3 operator status and refresh surfaces

OpenClaw does not yet have:

- a user-invokable connect action for ChatGPT apps
- a bridge from returned app-auth requirements into an OpenClaw browser flow
- a completion path that automatically refreshes inventory and tool publication

### Required Pre-Read

- `docs/specs/2026-03-chatgpt-apps/design.md`
- `docs/specs/2026-03-chatgpt-apps/2026-03-26-m1-sidecar-auth-inventory.md`
- `docs/specs/2026-03-chatgpt-apps/2026-03-26-m2-local-mcp-bridge.md`
- `docs/specs/2026-03-chatgpt-apps/2026-03-26-m3-operator-controls.md`
- `docs/flows/ref.chatgpt-login.md`
- `src/plugins/provider-auth-choice.ts`
- `src/cli/mcp-cli.ts`
- `src/cli/program/command-registry.ts`

### Constraints

- OpenClaw is CLI and gateway oriented, so the initial connect flow should be
  browser-capable and operator-driven rather than dependent on a Codex-specific
  desktop deeplink model.
- The flow should reuse source-backed app-server contracts rather than invent a
  parallel auth handshake.
- Successful auth completion must reuse Milestone 3 refresh orchestration so
  inventory and tools do not remain stale.
- Failure reporting must distinguish install-policy issues, browser-launch
  issues, OAuth completion failure, and post-connect refresh failure.

### Non-obvious Dependencies or Access (Optional)

- Some auth flows may require callback handling that differs between local and
  remote environments; OpenClaw may need a manual URL-paste fallback similar to
  provider OAuth.
- Apps may require auth either on install or on first use, so the connect UX
  must account for both `ON_INSTALL` and `ON_USE` policy shapes.

---

## Approach and Touchpoints

### Proposed Approach

Build a CLI/browser-first connect flow that layers on top of the prior
milestones:

1. Discover or identify the target app needing auth.
2. Start app-auth through the source-backed app-server login request.
3. Open the returned authorization URL in the browser, with a manual fallback
   for remote environments.
4. Wait for the completion notification or equivalent callback resolution.
5. Reuse Milestone 3 hard refresh semantics to re-project auth if needed,
   refetch inventory, and rebuild the local tool surface.

For install-driven flows, OpenClaw should also be able to consume the
`plugin/install` response contract so an install action can immediately route
into "apps needing auth" handling when applicable.

### Integration Points / Touchpoints

- `extensions/openai/chatgpt-apps/inventory.ts`
  Refresh inventory after auth completion and update app accessibility state.
- `extensions/openai/chatgpt-apps/mcp-bridge.ts`
  Rebuild the local tool surface after the post-connect refresh.
- `extensions/openai/chatgpt-apps/diagnostics.ts`
  Track connect-in-progress, connect-failed, and post-refresh outcomes.
- `extensions/openai/chatgpt-apps/connect-flow.ts`
  New orchestration layer for app connect and OAuth completion.
- `extensions/openai/chatgpt-apps/sidecar.ts`
  Issue the source-backed app auth requests through the app-server connection.
- `src/plugins/provider-auth-choice.ts`
  Reuse existing browser launch and remote/manual OAuth patterns where possible.
- `src/cli/mcp-cli.ts`
  Likely home for an initial operator-facing connect command if the existing
  `mcp` namespace is chosen.
- `src/cli/program/command-registry.ts`
  Wire the chosen connect command or subcommand into the CLI.
- `docs/cli/plugins.md` and `docs/cli/status.md`
  Document the new operator flow and how completion affects status output.

### Resolved Ambiguities / Decisions

- Source-backed contract: use the app-server's auth policy, app-auth request,
  and completion notification instead of inventing a bespoke connect protocol.
- UX shape: start with a CLI/browser-first operator flow that fits OpenClaw's
  environment instead of mirroring Codex desktop deeplinks exactly.
- Completion behavior: always trigger the existing hard-refresh pipeline after a
  successful connect so inventory and tools update without restart.
- Policy handling: support both `ON_INSTALL` and `ON_USE` app auth policy
  shapes.

### Important Implementation Notes (Optional)

- If OpenClaw cannot reliably consume an automatic callback in remote contexts,
  the flow should fall back to manual completion rather than abandoning support
  for those environments.
- The connect flow should report the target app id and auth state transition in
  status/JSON output so operators can tell which app is blocked.
- Post-connect refresh should be idempotent so repeated completion notifications
  do not duplicate work or destabilize bridge state.

---

## Acceptance Criteria

- [ ] OpenClaw exposes a documented operator-facing flow to connect an app that
      needs auth.
- [ ] The flow opens the app auth URL (or provides a documented remote/manual
      fallback), then observes completion through the source-backed auth
      completion mechanism.
- [ ] After successful app auth, OpenClaw refreshes inventory and republishes
      tools so the newly authorized app appears without gateway restart.
- [ ] Connect failures are surfaced through the operator diagnostics path with
      clear classification and next-step guidance.

---

## Phases and Dependencies

### Phase 1: Contract confirmation and target discovery

- [ ] Confirm the exact app-server request/notification contract OpenClaw will
      consume for app auth.
- [ ] Decide how operators specify the target app needing auth.
- [ ] Reuse or extend install responses that report `appsNeedingAuth`.

### Phase 2: Browser flow orchestration

- [ ] Implement a connect action that requests the authorization URL.
- [ ] Reuse existing browser-open helpers and remote/manual OAuth fallbacks.
- [ ] Track connect progress and completion state for the target app.

### Phase 3: Completion and refresh

- [ ] Observe auth completion and map failures into the Milestone 3 diagnostic
      model.
- [ ] Trigger the coordinated hard refresh after successful completion.
- [ ] Ensure the bridge republishes tools for the newly authorized app.

### Phase 4: Documentation and operator guidance

- [ ] Document the connect flow, including remote/manual fallback behavior.
- [ ] Document how install-policy-driven auth requirements map into operator
      actions.
- [ ] Document the expected post-connect refresh behavior and failure handling.

### Phase Dependencies

- Phase 2 depends on the source-backed contract work from Phase 1.
- Phase 3 depends on the refresh orchestration from Milestone 3 and the bridge
  publication logic from Milestone 2.
- Phase 4 depends on the final command shape and completion semantics from the
  earlier phases.

---

## Validation Plan

Integration tests:

- Add a connect-flow integration test that stubs `mcpServer/oauth/login`,
  returns an authorization URL, and verifies the flow launches browser auth.
- Add a completion integration test that simulates the auth-completed
  notification and verifies inventory plus tool publication refresh.
- Add an install-policy integration test that exercises `ON_INSTALL` app auth
  requirements and routes directly into the connect flow.
- Add a failure integration test for OAuth completion failure and verify the
  operator diagnostics surface the correct reason.

Unit tests (Optional):

- Add unit tests for connect-state transitions and failure classification.
- Add unit tests for target-app selection and required-auth state handling.

Manual validation:

- Connect a previously unauthorized app and verify it appears in inventory and
  the local tool surface without restarting the gateway.
- Repeat from a remote/manual OAuth environment and verify the documented
  fallback works.
- Trigger a failed app-auth flow and verify the status surfaces point the
  operator to the right recovery action.

---

## Done Criteria

- [ ] OpenClaw can initiate app auth and converge to updated inventory and tool
      publication without restart.
- [ ] The connect flow is documented and wired into the operator diagnostics
      story from Milestone 3.
- [ ] The full milestone spec set covers install, auth, inventory, bridge, and
      operator workflows coherently.

---

## Open Items and Risks

### Open Items

- [ ] Decide the exact CLI surface for connect actions.
- [ ] Confirm whether OpenClaw needs to support install-plus-connect in one
      operator action or can start with connect-only for already installed apps.
- [ ] Confirm the remote/manual callback strategy for environments that cannot
      receive automatic callback URLs.

### Risks and Mitigations

| Risk                                                                                                         | Impact | Probability | Mitigation                                                                                         |
| ------------------------------------------------------------------------------------------------------------ | ------ | ----------- | -------------------------------------------------------------------------------------------------- |
| OpenClaw copies Codex desktop callback assumptions that do not fit CLI or remote environments                | High   | Med         | Reuse existing browser-open and manual callback patterns instead of desktop-only deeplink behavior |
| Auth completes successfully but inventory/tool refresh does not run, leaving the app apparently disconnected | High   | Med         | Always funnel completion through the Milestone 3 hard-refresh orchestration                        |
| Install-policy handling is incomplete and operators do not know when auth is required                        | Med    | Med         | Surface `appsNeedingAuth` and auth policy clearly in the operator flow and docs                    |
| Connect diagnostics are too generic to recover from failures                                                 | Med    | Med         | Reuse the milestone 3 diagnostic taxonomy and include app-target context in failures               |

### Simplifications and Assumptions (Optional)

- This milestone assumes the first useful OpenClaw UX can be CLI-first instead
  of a full graphical app directory.
- This milestone assumes post-connect state convergence should reuse, not
  duplicate, the refresh path added in Milestone 3.

---

## Outputs

- PR created from this spec: Not started

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-03-26: Created milestone 4 execution plan for ChatGPT app connect flow parity. (019d2b82-77db-7072-9814-fc41a5c45062)
