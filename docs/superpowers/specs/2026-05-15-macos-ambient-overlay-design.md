# macOS Ambient Overlay Design

## Summary

OpenClaw should add a macOS ambient overlay mode: a subtle full-screen AI layer that is visible without blocking the desktop, then becomes interactive when the user presses a global hotkey. The overlay should start on the current display by default, support an optional all-displays mode, and expose two primary armed-mode surfaces:

- contextual annotation pins over the current screen
- a bottom command/workspace sheet for agent actions

The feature should be implemented as a layered native macOS overlay system, not as a single full-screen WebView. AppKit owns windowing, click-through behavior, display placement, and focus. SwiftUI owns native controls and settings. WebKit remains optional for the richer workspace surface if the existing Canvas web experience is the better fit for iteration.

## Goals

- Provide a polished "Pins + Sheet" overlay experience.
- Keep the desktop usable by default: the ambient layer must not steal clicks.
- Arm the overlay with a global hotkey.
- Let only explicit pins, chips, and workspace controls receive interaction while armed.
- Support current-display and all-displays modes.
- Degrade gracefully when Screen Recording, Accessibility, or hotkey permissions are unavailable.
- Reuse existing OpenClaw macOS overlay, hotkey, Canvas, and permission patterns where possible.

## Non-Goals

- Do not replace the existing Canvas panel in the first version.
- Do not build a React Native shell.
- Do not make the entire screen interactive while armed.
- Do not require Screen Recording or Accessibility for the basic visual overlay.
- Do not implement deep semantic screen understanding in the first phase.

## Product Behavior

### Idle State

In idle state, OpenClaw shows a subtle ambient layer over the active display. The layer can render restrained visual hints such as edge framing, light status glows, or a quiet "ready" presence, but it must not block mouse or keyboard input. The user should be able to work normally in any underlying app.

### Armed State

The global hotkey toggles the overlay into armed state. In armed state:

- a command/workspace sheet appears near the bottom-center of the active display
- annotation pins or chips may appear over relevant regions
- only pins, chips, and the workspace sheet are interactive
- the rest of the desktop remains pass-through
- `Esc`, the global hotkey, an explicit close control, or inactivity returns the overlay to idle state

### Display Scope

The default display scope is "current display". The current display should be resolved from the frontmost context when possible, falling back to the mouse location. A setting can switch the feature to "all displays", where each display gets its own ambient layer and only the active display shows the workspace sheet unless later product work says otherwise.

## Architecture

### Click-Through Contract

The overlay should be built as multiple AppKit panels rather than one full-screen interactive surface:

- the ambient panel is always `ignoresMouseEvents = true`
- annotation and workspace panels are separate windows that exist only while armed or executing
- idle mode never toggles a full-screen window into an interactive state
- armed mode makes only visible controls interactive
- dismissing armed mode destroys or hides interactive panels before returning to idle visuals

This is the key technical boundary for preserving normal desktop behavior. It also gives tests a clear invariant: if the overlay is idle, the only visible window should be passive.

### OverlayExperienceController

`OverlayExperienceController` is the top-level state machine. It owns:

- current overlay state
- display scope
- active display selection
- lifecycle of per-display controllers
- transitions between idle, arming, armed, executing, and cooldown

It should be a `@MainActor` controller, following existing macOS app patterns for overlay controllers.

### OverlayDisplayController

`OverlayDisplayController` owns the windows for one `NSScreen`:

- ambient panel
- annotation panel
- workspace panel

It should observe screen frame changes indirectly through a higher-level screen refresh path rather than caching `NSScreen.screens` indefinitely.

### AmbientOverlayPanel

The ambient panel is a full-screen transparent AppKit panel. It should:

- use a borderless/nonactivating overlay style
- join all Spaces when the existing overlay behavior allows it
- support full-screen auxiliary behavior
- set `ignoresMouseEvents = true`
- never become key or main
- render only passive visuals

This panel is always safe to show because it does not interact with the desktop.

### AnnotationOverlayPanel

The annotation panel hosts interactive pins and chips while armed. It should:

- be transparent
- appear only in armed or executing states
- receive mouse events only while armed
- keep hit targets limited to visible annotation elements
- hide or disable itself when no annotations are available

The first version can use native SwiftUI views in an `NSHostingView`. A later version can add a more advanced hit-testing strategy if annotations become dense.

### WorkspaceOverlayPanel

The workspace panel is the bottom command/action surface. It should:

- appear only while armed or executing
- be native SwiftUI for the first version
- include prompt input, suggested actions, active task status, and dismiss controls
- avoid stealing focus until the user explicitly interacts with it

If the workspace grows into a complex mini-app, it can embed WebKit and reuse Canvas/A2UI patterns.

### OverlayHotkeyController

`OverlayHotkeyController` should follow the existing global/local monitor pattern used by push-to-talk. It should:

- monitor a configurable hotkey
- call into `OverlayExperienceController` on activation
- avoid conflicting with the existing right Option push-to-talk behavior
- expose a menu-bar fallback trigger when global monitoring is unavailable

The first implementation should use `Control+Option+Space` as the default shortcut, with settings support to change it later. This avoids the existing right Option push-to-talk behavior and keeps the first slice concrete. Because macOS and keyboard layouts can reserve nearby shortcuts for input-source switching, the first build must also include a menu-bar "Open Ambient Overlay" fallback so the feature remains usable before custom shortcut editing ships.

### ScreenUnderstandingService

`ScreenUnderstandingService` provides optional context:

- ScreenCaptureKit for pixels and screenshots
- Accessibility APIs for semantic element lookup
- frontmost app/window metadata where available

The first phase should only need a coarse snapshot or no screen understanding at all. Annotation pins can start as synthetic or agent-provided suggestions, then become screen-aware in later phases.

### OverlaySettingsStore

Settings should include:

- enabled/disabled
- display scope: current display or all displays
- hotkey
- ambient intensity
- armed timeout
- annotation density
- debug overlay mode

These settings should live with existing macOS app state and settings patterns. Suggested defaults keys:

- `openclaw.ambientOverlayEnabled`
- `openclaw.ambientOverlayDisplayScope`
- `openclaw.ambientOverlayIntensity`
- `openclaw.ambientOverlayTimeoutSeconds`

The first implementation should use a subtle edge glow or frame at low opacity as the default ambient visual treatment. Armed mode should time out after 30 seconds of inactivity and return to idle.

## State Machine

`idle`: Ambient layer visible and click-through. No interactive surfaces are active.

`arming`: Hotkey was accepted. The app resolves display scope, refreshes screen context if available, and prepares surfaces.

`armed`: Annotation pins and workspace sheet are visible. Pins and sheet are interactive; everything else remains pass-through.

`executing`: The agent is working from an overlay command or annotation action. The workspace sheet shows progress and status.

`cooldown`: The overlay dismisses interactive surfaces and returns to idle visuals.

## Permissions and Degraded Modes

The basic overlay should work without Screen Recording or Accessibility.

Without Screen Recording:

- ambient overlay works
- workspace sheet works
- annotations are limited to generic or agent-provided context
- screen-aware suggestions are disabled

Without Accessibility:

- ambient overlay works
- workspace sheet works
- semantic UI lookup is disabled
- global hotkey support may be limited depending on the monitoring path

Without reliable global hotkey monitoring:

- menu bar activation remains available
- settings should explain the missing permission

## Framework Choices

Use AppKit for:

- NSPanel/NSWindow construction
- click-through behavior
- z-order and Spaces behavior
- multi-display placement
- event monitoring

Use SwiftUI for:

- workspace sheet UI
- annotation chips and controls
- settings
- debug panels

Use WebKit only for:

- optional richer workspace content
- reuse of existing Canvas/A2UI content when it is clearly helpful

Use ScreenCaptureKit for:

- screen snapshots
- future live visual context

Use Accessibility APIs for:

- trusted semantic lookup
- element-at-position queries
- frontmost UI context when available

Avoid React Native. React may be considered only inside a WebKit-hosted workspace if the workspace grows beyond what native SwiftUI can comfortably support.

## Implementation Phases

### Phase 1: Passive Ambient Overlay

- Add overlay settings defaults.
- Add `OverlayExperienceController`.
- Add one `OverlayDisplayController`.
- Show a current-display ambient panel.
- Ensure idle overlay is fully click-through.
- Add basic tests for display selection and state transitions.

### Phase 2: Hotkey-Armed Workspace

- Add `OverlayHotkeyController`.
- Add bottom workspace panel.
- Implement idle to armed to idle transitions.
- Add menu bar fallback activation.
- Add tests for hotkey state transitions.

### Phase 3: Annotation Pins

- Add annotation panel.
- Add native SwiftUI pin/chip views.
- Add first generic suggested actions.
- Keep hit testing limited to visible controls.
- Add tests for annotation lifecycle.

### Phase 4: Multi-Display Mode

- Add display scope setting.
- Create per-screen ambient panels.
- Keep workspace on the active display.
- Handle display configuration changes.
- Add tests for display controller reconciliation.

### Phase 5: Screen-Aware Suggestions

- Integrate ScreenCaptureKit snapshots.
- Integrate Accessibility element lookup.
- Add degraded-mode UI when permissions are missing.
- Add focused manual verification flows for permissions.

## Testing Strategy

Unit tests:

- state machine transitions
- display scope resolution
- screen controller reconciliation
- permission downgrade logic
- hotkey activation/deactivation logic

Smoke tests:

- ambient overlay can show and hide
- idle state is click-through
- armed workspace appears on active display
- all-displays mode creates one controller per display
- full-screen app coexistence

Manual checks:

- hotkey works while another app is frontmost
- overlay does not trap clicks in idle state
- only pins and workspace controls are interactive while armed
- Escape dismisses armed mode
- app behaves sensibly without Screen Recording and Accessibility permissions

## Product Decisions

- Default hotkey: `Control+Option+Space`.
- Required fallback activation: menu-bar "Open Ambient Overlay".
- First workspace implementation: native SwiftUI.
- Idle ambient treatment: subtle low-opacity edge glow or frame.
- Armed inactivity timeout: 30 seconds.
- Default display scope: current display.

## First Slice Acceptance Criteria

The first shippable slice is complete when:

- the feature can be enabled or disabled from General settings
- enabling it shows a passive ambient layer on the current display
- idle ambient mode is click-through
- `Control+Option+Space` or the menu fallback arms the overlay
- armed mode shows a native bottom workspace sheet
- `Esc`, the hotkey, close control, or 30 seconds of inactivity returns to idle
- disabling the feature closes all overlay panels
- tests cover state transitions, display selection, hotkey activation, and settings persistence

## Recommended First Build Slice

The first implementation should build Phase 1 and the smallest part of Phase 2:

- a current-display ambient overlay
- an idle/armed state machine
- a simple global hotkey or menu fallback
- a placeholder bottom workspace sheet
- tests for state and display behavior

This gives a visible, usable proof of the experience without committing early to complex annotation intelligence or multi-display orchestration.
