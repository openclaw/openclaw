# Ambient Assistant Layer Design

## Summary

OpenClaw should evolve the macOS Ambient Overlay into a full assistant layer: a transparent desktop presence that can understand the current work context, accept fast commands, propose useful actions, execute approved work, and hand off across macOS, Canvas, WebUI, gateway tools, and iOS.

The product direction is **Ambient Assistant Layer**, not a mini Canvas clone and not a fully autonomous background daemon. Canvas remains the deep visual workspace. The ambient layer is the fast invocation, context, approval, and status surface that makes Thomas feel available across the whole screen without taking over the desktop.

## Goals

- Keep the normal desktop usable in idle mode.
- Provide one dependable keyboard-first composer for asking Thomas to act.
- Make Thomas feel present through the floating orb, state, motion, and concise activity labels.
- Surface enough context to be helpful: active app, selected content, screen/window signals, session, device status, gateway health, and permissions.
- Split assistant behavior into bounded subagents so each subsystem can be tested, replaced, and implemented independently.
- Support safe automation through proposals, approvals, receipts, and policy gates.
- Reuse existing OpenClaw primitives: Gateway, sessions, tools, nodes, Canvas/A2UI, cron, tasks, commitments, WorkActivityStore, voice/talk, and macOS permission services.

## Non-Goals

- Do not render a full transcript or full dashboard inside the ambient overlay.
- Do not make the entire screen interactive.
- Do not silently send external messages, delete data, make purchases, alter permissions, or perform sensitive actions.
- Do not replace Canvas, WebUI, or Settings.
- Do not require Screen Recording or Accessibility for the basic overlay to open.
- Do not build React Native. Native AppKit and SwiftUI remain the macOS shell.

## Product Model

The assistant layer has five visible modes:

1. **Idle Ambient**
   The full-screen ambient layer is visible and click-through. Thomas is hidden or very subtle. No keyboard focus is stolen.

2. **Armed Composer**
   `Control-Option-Space` opens the bottom composer on the active display. The composer becomes key, text input is focused, and Thomas floats above it.

3. **Context Review**
   The overlay can show compact context: active app/window, selected text, current session, available devices, permission state, and inferred intent.

4. **Working**
   Thomas shows visible progress while tools, gateway calls, node commands, or agent turns are running. The UI favors one-line activity updates over verbose logs.

5. **Approval / Receipt**
   Risky or external actions pause behind an approval card. Completed actions leave a receipt with what happened, where it happened, and how to inspect or undo it when possible.

## Advanced Layout

The first advanced layout should use four regions:

- **Passive Ambient Layer**
  Full-screen AppKit panel, click-through, current-display or all-displays, visual-only. It dims slightly while the composer is armed.

- **Bottom Composer**
  Centered, 760-900 px preferred width, key-capable panel. Includes prompt input, slash commands, submit, dismiss, inline result strip, selected session, and concise status.

- **Thomas Orb**
  Floating, stateful, visually separate from the composer. It uses the existing Thomas avatar asset and Canvas-like motion. It is not a click target in the first advanced implementation.

- **Context / Action Lanes**
  Compact optional panels around the composer or upper screen edge:
  - context lens: active app, selection, device, permissions
  - subagent lane: which helper is active
  - proposal lane: suggested action, confidence, approval state
  - receipt lane: latest completed action

These lanes appear only when useful. The default armed view remains calm: Thomas, composer, and one status line.

## Functionality Split

### 1. Context Scout

Purpose: gather relevant context without acting.

Inputs:
- frontmost app/window metadata
- selected text and clipboard when available
- screen snapshot summary when Screen Recording is granted
- Accessibility element summary when Accessibility is granted
- current OpenClaw session
- gateway health
- device/node availability
- pending tasks/actions/commitments

Outputs:
- `AssistantContextSnapshot`
- confidence and permission state
- concise user-visible context label

Constraints:
- never performs actions
- never stores sensitive screen or clipboard content unless a downstream approved action needs it
- degrades gracefully when permissions are missing

### 2. Intent Planner

Purpose: convert a user request or contextual opportunity into an executable plan.

Inputs:
- user prompt or slash command
- `AssistantContextSnapshot`
- capability broker results
- memory/preferences

Outputs:
- plan summary
- ordered action steps
- required approvals
- missing information questions
- suggested subagent assignments

Constraints:
- plans should be reversible when possible
- low-confidence plans ask before acting
- no direct tool execution

### 3. Capability Broker

Purpose: answer what OpenClaw can do right now.

It wraps:
- `tools.catalog`
- `tools.effective`
- node capabilities and command schemas
- gateway scopes
- macOS permissions
- iOS availability
- Canvas/WebUI availability
- configured channels and credentials

Outputs:
- available now
- unavailable with reason
- requires permission
- requires approval
- requires foreground device
- can draft only
- can execute silently

### 4. Action Proposal Service

Purpose: turn plans into durable user-facing proposals.

Each proposal includes:
- title
- rationale
- source context
- confidence
- risk level
- required capability
- required approval policy
- preview data
- status: proposed, approved, running, done, failed, dismissed
- related session/task/cron/action ids
- receipt after completion

This should extend or wrap the existing action queue rather than inventing a disconnected store.

### 5. Execution Orchestrator

Purpose: execute approved actions through existing OpenClaw capabilities.

Targets:
- gateway tools
- `chat.send`, `sessions.send`, `sessions.steer`
- `agent`
- `tools.invoke`
- Canvas/A2UI
- browser control
- cron jobs
- tasks
- node commands
- iOS pending work / push wake
- notifications

Outputs:
- progress events
- execution result
- receipt
- retry/fallback suggestion

Constraints:
- only executes approved or safe actions
- records receipts for all meaningful user-visible work
- can pause for user confirmation mid-plan

### 6. Safety Clerk

Purpose: keep automation trustworthy.

Responsibilities:
- classify risky actions
- enforce ask-first rules
- protect external sends, destructive changes, purchases, sensitive data, permission changes, and credential operations
- manage quiet hours and notification budget
- provide audit trail
- require previews for messages or changes when appropriate

Default policy:
- read-only local context can happen silently when permissions already allow it
- drafting is allowed
- external sending requires approval
- destructive or financial actions require explicit approval
- browser/system permission changes require explicit approval
- sensitive data transmission requires approval with destination and data summary

### 7. Memory Curator

Purpose: store durable preferences and open loops.

Stores:
- user preferences
- people/project references
- recurring workflows
- dismissed suggestions
- accepted automation patterns
- commitments and follow-ups

Constraints:
- memory writes should be visible or inferable
- sensitive content should be minimized
- dismissed suggestions should suppress repeats

### 8. Surface Adapters

Purpose: render the same assistant model everywhere.

Surfaces:
- Ambient Overlay
- Canvas/A2UI
- WebUI
- native macOS notifications
- iOS app
- chat/session transcript

Shared renderables:
- context snapshot
- proposal card
- approval card
- receipt card
- working status
- error recovery card

### 9. Thomas Presence

Purpose: own personality, visual state, and motion.

States:
- ready
- focused
- reading
- planning
- waiting for approval
- sending
- working
- success
- error
- quiet

Rules:
- calm by default
- more expressive while actively helping
- reduced motion for errors
- hidden or subtle in idle mode

### 10. Gateway Doctor

Purpose: make health problems visible and recoverable.

Tracks:
- gateway process status
- active port and URL
- auth state
- paired nodes
- iOS reachability
- BlueBubbles/iMessage integration if configured
- Tailscale/tunnel state
- last failure and recommended fix

Actions:
- health check
- restart gateway
- open logs
- reset tunnel
- show pairing/device status

## Data Model

### AssistantContextSnapshot

Fields:
- id
- createdAt
- frontApp
- frontWindowTitle
- selectedTextSummary
- screenSummary
- sessionKey
- gatewayStatus
- nodeStatus
- permissionStatus
- confidence
- redactions

### AssistantCapability

Fields:
- id
- label
- source: tool, gateway, node, canvas, macOS, iOS, browser, channel
- availability
- unavailableReason
- requiredPermission
- requiredApproval
- riskLevel
- invocationTarget

### AssistantProposal

Fields:
- id
- title
- rationale
- source
- status
- confidence
- riskLevel
- requiredCapabilities
- approvalPolicy
- preview
- executionPlan
- receipt
- createdAt
- updatedAt

### AssistantReceipt

Fields:
- id
- proposalId
- summary
- target
- artifactLinks
- undoHint
- auditEvents
- completedAt

## macOS Architecture

### Native Shell

Use AppKit for:
- passive ambient panels
- key-capable command dock panel
- window levels
- Spaces/full-screen behavior
- click-through invariants
- hotkey/event monitors

Use SwiftUI for:
- composer
- Thomas orb
- context lanes
- proposal cards
- approval cards
- receipt cards
- settings

Use WebKit only to open or embed richer Canvas/A2UI surfaces when needed.

### Controllers

`AmbientOverlayExperienceController` should become the top-level lifecycle coordinator with richer states:

- idle
- arming
- composing
- readingContext
- planning
- showingProposal
- awaitingApproval
- executing
- showingReceipt
- error
- cooldown

`AmbientOverlayDisplayController` should remain responsible for per-display panels and placement.

`AmbientCommandDockModel` should remain the testable model for input, suggestions, result, and Thomas state. It should gain bindings to assistant progress and proposal state rather than owning execution logic directly.

### Gateway / TypeScript Architecture

Add a server-side assistant automation layer around existing gateway features:

- assistant context service
- capability broker
- proposal service
- execution orchestrator
- surface render model
- receipt store

This should reuse existing `actions`, `tasks`, `cron`, `commitments`, `tools`, `sessions`, and `nodes` instead of duplicating them.

## Keyboard Behavior

- `Control-Option-Space`: arm or dismiss
- `Escape`: close suggestions first, then dismiss composer
- `Enter`: submit prompt or selected command
- `Shift-Enter`: newline once multiline input is enabled
- `Tab`: accept suggestion
- Up/Down: navigate suggestions or proposal actions
- `/`: command suggestions
- `Command-Enter`: approve selected safe proposal when focus is inside approval card

## Command Model

Keep slash commands as the fast operator layer.

Immediate commands:
- `/help`
- `/status`
- `/health`
- `/canvas`
- `/chat`
- `/settings`
- `/logs`
- `/restart-gateway`
- `/display current|all`
- `/intensity 10-100`

Advanced commands:
- `/context`
- `/act`
- `/watch`
- `/approve`
- `/dismiss`
- `/receipt`
- `/handoff iphone`
- `/memory`
- `/capabilities`

Commands should show argument hints, availability, and failure reasons. Unsupported commands should explain what is missing.

## Implementation Phases

### Phase 1: Assistant Surface Foundation

- Add assistant state models in macOS.
- Add context/status lanes behind the current composer.
- Show active session, gateway status, and WorkActivityStore activity.
- Add richer Thomas states.
- Add `/context`, `/capabilities`, `/receipt`, and `/handoff iphone` command stubs that return honest unavailable states until their backing services ship.
- Keep all interaction local and safe.

### Phase 2: Capability Broker

- Add TypeScript capability broker around tools, nodes, permissions, and gateway state.
- Expose a typed gateway method for effective assistant capabilities.
- Render capabilities in the overlay.
- Add tests for availability, permissions, and node/device status.

### Phase 3: Proposal Service

- Extend or wrap the existing action queue into assistant proposals.
- Add proposal lifecycle and receipts.
- Render proposal/approval/receipt cards in ambient overlay and WebUI/Canvas where possible.
- Add safety policy classification.

### Phase 4: Execution Orchestrator

- Convert approved proposals into gateway/tool/node/session calls.
- Stream progress back to the overlay.
- Record receipts.
- Add retry and fallback handling.

### Phase 5: Proactive Watchers

- Add opt-in watchers for selected domains:
  - gateway health
  - iMessage/BlueBubbles health
  - active task completion
  - iOS reachability
  - pending approvals
- Watchers propose actions but do not silently perform risky work.

### Phase 6: Cross-Device Handoff

- Integrate iOS node availability and pending work.
- Add `/handoff iphone`.
- Render proposal/receipt cards on iOS.
- Support push wake and foreground-required messaging.

## Testing

Unit tests:
- context snapshot normalization
- capability availability and permission reasons
- proposal lifecycle
- approval policy classification
- receipt creation
- command parsing and argument hints
- Thomas state mapping
- overlay state transitions

Integration tests:
- prompt to proposal
- proposal to approval
- approval to execution
- execution to receipt
- gateway unavailable recovery
- node unavailable fallback

macOS smoke tests:
- overlay still opens and focuses
- click-through idle remains intact
- Escape dismisses
- one-display and all-display modes work
- context lane collapses when no data is available
- proposal/approval cards do not resize the composer unexpectedly

Manual verification:
- ask Thomas to summarize visible context
- ask Thomas to draft but not send a message
- approve a safe local action
- reject a risky action
- restart gateway from overlay
- hand off a simple pending action to iPhone

## Risks

- **Focus stealing:** the composer must become key only while armed. Idle mode must never steal focus.
- **TCC fragility:** Screen Recording and Accessibility depend on bundle identity and install path. The UI must explain permission state clearly.
- **Noisy automation:** proactive suggestions must be capped, dismissible, and remembered.
- **Overstuffed overlay:** the ambient layer must remain a fast invocation surface, not a second WebUI.
- **Cross-device reliability:** iOS foreground/background limits must be visible in capability status.
- **Safety debt:** automation without approvals and receipts would quickly erode trust.

## Success Criteria

- The user can press `Control-Option-Space`, ask Thomas for help, and see what Thomas knows, plans, and does.
- The desktop remains usable except for the explicit composer/control regions.
- The assistant can explain why an action is available or blocked.
- Risky work pauses for approval with a clear preview.
- Completed work leaves a useful receipt.
- Gateway and iOS health are visible from the overlay.
- The architecture allows subagents to be implemented independently without tangling UI, policy, execution, and memory.
