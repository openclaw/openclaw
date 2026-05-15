# Ambient Command Dock Design

## Goal

Turn the macOS Ambient Overlay from a visual presence layer into a rich, keyboard-first chat composer that lets the user talk to Thomas from anywhere, run local OpenClaw actions through slash commands, and see lightweight status without opening the full Canvas or WebUI.

## Product Direction

The overlay remains ambient and full-screen: transparent, visually alive, and click-through outside the interactive surface. The primary interaction is a bottom-centered chat composer. Typing normal text sends a prompt to the active/current OpenClaw session. Typing `/` opens command suggestions that can run local app actions, adjust overlay settings, inspect status, or open richer surfaces.

Thomas should appear as a separate floating orb, matching the Canvas personality rather than being embedded as a static badge. The orb uses the existing `thomas_avatar.png` asset and borrows the Canvas live-orb language: a circular avatar, conic orbit ring, pulsing outer ring, subtle breathing scale, and independent floating/drifting motion around the composer. It reflects state: ready, focused, sending, working, success, and error.

## Experience

### Idle Ambient

- When Ambient Overlay is enabled but not armed, the user sees only the transparent ambient layer.
- The layer remains click-through and does not capture keyboard input.
- The Thomas orb may be hidden or very subtle in idle state; it should not steal focus.

### Armed Composer

- `Control-Option-Space` arms the overlay.
- The bottom composer appears above the ambient decoration.
- Thomas floats above or near the composer as an independent presence, with Canvas-like motion rather than a fixed badge position.
- The input field is focused automatically.
- `Escape` dismisses the composer and returns to ambient-only mode.
- Clicking outside the composer does not block the underlying app because the fullscreen ambient layer stays click-through.

### Prompt Submission

- Plain text submission sends to the selected/current session.
- The first implementation should route through the existing gateway/send path already used by voice wake and WebUI rather than creating a new agent API.
- The composer shows inline send state: sending, sent, failed, or unavailable.
- After a successful send, the input clears and the composer can either stay open for follow-up or collapse according to a configurable behavior. Default: stay open briefly, then dismiss after success if there is no new typing.

### Slash Commands

Slash commands are a power layer inside the chat composer, not a separate command palette. They should be discoverable through autocomplete and grouped help.

Initial command groups:

- Core: `/help`, `/clear`, `/dismiss`, `/status`
- Surfaces: `/canvas`, `/chat`, `/dashboard`, `/settings`, `/agent-events`
- Voice/Talk: `/talk`, `/voice-wake`, `/mic`
- Gateway/Health: `/health`, `/restart-gateway`, `/reset-tunnel`, `/logs`, `/config`, `/session-store`
- Sessions: `/sessions`, `/main`, `/new`, `/compact`, `/reset-session`
- Modes/Permissions: `/approvals`, `/browser`, `/camera`, `/ambient`, `/display current`, `/display all`, `/intensity <10-100>`
- Automation/Actions: `/cron`, `/actions`, `/skills`, `/nodes`

Commands can be implemented incrementally, but the command registry should be designed for the whole list from the start. Unsupported or disabled commands should render an inline explanation rather than silently failing.

## Architecture

### Overlay Controller

`AmbientOverlayExperienceController` continues to own arming, dismissal, timeout, and keyboard monitor lifecycle. It should gain a richer armed model that can represent composer-focused states:

- idle
- ambient
- composing
- sending
- commandResult
- error

The existing `AmbientOverlayState` can either be extended or wrapped by a more specific composer model. Avoid stuffing command parsing and gateway logic directly into the experience controller.

### Display Controller

`AmbientOverlayDisplayController` continues to own `NSPanel` creation and display targeting. It should replace the existing minimal workspace sheet with a composer panel whose content view is a new SwiftUI view. The fullscreen ambient panels remain non-interactive. The composer panel remains interactive and above the ambient decoration.

### Composer Model

Create a dedicated `AmbientCommandDockModel` responsible for:

- current input text
- focused/suggestion state
- selected suggestion index
- last result message
- Thomas orb state
- active session summary
- command execution state

This model should be testable without AppKit panels.

### Command Registry

Create a small command registry instead of a switch buried in the view. Each command definition should include:

- command name
- aliases
- group
- short description
- argument hint
- availability rule
- execution closure or action enum

The parser should support:

- exact commands, e.g. `/canvas`
- arguments, e.g. `/intensity 70`
- prefix suggestions, e.g. `/res` suggests `/reset-tunnel` and `/reset-session`
- unknown command feedback

### Action Execution

Local actions should reuse existing OpenClaw paths:

- Canvas: `CanvasManager.shared`
- Chat: `WebChatManager.shared`
- Settings: `SettingsWindowOpener.shared`
- Logs/config/session store: `DebugActions`
- Gateway restart/reset/health: `DebugActions`, `GatewayConnection`, `HealthStore`
- Talk and voice wake: existing AppState/Talk/VoiceWake settings paths

Plain text prompts should use the existing gateway agent send path, likely via a small reusable helper based on `VoiceWakeForwarder` semantics but with composer-specific copy. The message should not include the voice wake transcript preamble.

### Thomas Orb

Use the existing asset:

`apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/CanvasScaffold/thomas_avatar.png`

The orb should be a separate SwiftUI component with state-driven styling:

- Ready: slow breathing, gentle drift, green/teal status
- Focused: brighter ring, active input glow, drift centered above the composer
- Sending: faster orbit/pulse and slightly tighter float amplitude
- Working: tool/state label from `WorkActivityStore`, active orbit ring, and slow positional drift so Thomas feels present while work is happening
- Success: short confirmation glow, relaxed breathing after the flash
- Error: amber/red ring with inline message and reduced motion to avoid making failures feel frantic

The orb should be visually independent from the composer, floating above or near it. Its motion should use Canvas as the reference: breathing scale, conic spin, pulse ring, and mild vertical/horizontal drift. The actual implementation can live in the same composer panel for v1 to avoid complex multi-panel focus behavior, but it should be coded as its own component so it can later become a separate panel if needed.

## UI Details

The composer should be bottom-centered with a restrained, glassy look that matches the current macOS app:

- 760-860 px preferred width on desktop
- responsive max width based on active display
- compact header showing `Thomas`, current session, and status
- input field with placeholder: `Ask Thomas or type / for commands...`
- command suggestions as compact rows or chips above the input
- inline result strip for success/error/status output
- no large dashboard cards in v1

The overlay should not duplicate the full WebUI or Canvas. It is a fast entry surface, not another primary workspace.

## Keyboard Behavior

- `Control-Option-Space`: arm/dismiss composer
- `Escape`: close suggestions first, then dismiss composer
- `Enter`: submit prompt or command
- `Shift-Enter`: insert newline if multiline support is enabled; otherwise ignored in v1
- Up/Down: move through suggestions when suggestions are visible
- Tab: accept highlighted suggestion
- `/`: open command suggestions

The global hotkey must keep repeat protection.

## Error Handling

- Gateway unavailable: show inline error and offer `/health` or `/restart-gateway`
- Unknown command: show closest matches and `/help`
- Disabled feature: explain what setting must be enabled
- Invalid arguments: show usage, e.g. `/intensity 10-100`
- Send failure: preserve input text and show retry affordance

Errors should not open modal alerts from the composer unless the invoked action already requires a system permission prompt.

## Testing

Unit tests should cover:

- command parsing
- suggestion filtering
- command availability
- argument validation
- prompt vs slash-command routing
- composer model state transitions
- Thomas orb style state mapping
- Thomas orb motion profile mapping, including ready/focused/sending/working/error variants
- display/window level ordering remains correct

Smoke tests should cover:

- composer view builds
- command help view builds
- settings view still builds with Ambient Overlay enabled

Manual verification should cover:

- arming focuses the input
- click-through still works outside composer
- plain text sends to current session
- `/canvas`, `/chat`, `/settings`, `/logs`, `/status`, and `/intensity` work
- Escape behavior is predictable
- one-display and all-display modes still render correctly

## Non-Goals For This Iteration

- Full screen-aware autonomous clicking
- Drawing target annotations over live app elements
- Replacing WebUI or Canvas
- Multi-message transcript rendering inside the overlay
- Fully custom command scripting
- Voice dictation inside the composer beyond existing Talk/Voice Wake toggles

## Final Decisions For V1

- Prompt submit keeps the composer open briefly, then dismisses after a successful send if the user does not type more.
- Thomas orb is stateful/decorative in v1, not a separate click target, and it behaves like the Canvas floating live orb rather than a fixed avatar badge.
- `/new` opens Chat until the repo has a stable direct new-session API for the macOS app.
