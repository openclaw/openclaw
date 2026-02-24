# OpenClaw Android UI Style Guide

Scope: `apps/android` native app (Kotlin + Jetpack Compose).  
Goal: cohesive, high-clarity UI with deterministic behavior.

## 1. Design Direction

- Utility first: each screen has one obvious primary action.
- Calm surface: strong text contrast, restrained accents, minimal chrome.
- Progressive disclosure: advanced controls behind explicit affordances.
- Deterministic flow: validate early, block invalid progression, no hidden state.

## 2. Source Of Truth

Design and UI behavior anchors:

- `app/src/main/java/ai/openclaw/android/ui/OpenClawTheme.kt`
- `app/src/main/java/ai/openclaw/android/ui/RootScreen.kt`
- `app/src/main/java/ai/openclaw/android/ui/SettingsSheet.kt`
- `app/src/main/java/ai/openclaw/android/ui/chat/*`
- `app/src/main/java/ai/openclaw/android/MainViewModel.kt`

If design changes, update shared theme/primitives first, then feature screens.

## 3. Tokens And Theming

Do not introduce ad-hoc style values in feature composables.

### Color + Typography

- Prefer `MaterialTheme.colorScheme` and `MaterialTheme.typography`.
- Reuse `overlayContainerColor()` and `overlayIconColor()` for overlay controls.
- Avoid raw `Color(...)` literals except explicit semantic state cues.
- Keep text hierarchy clear: headline/body/supporting label styles, no random font sizes.

### Spacing + Shape

- Keep spacing rhythm consistent (`8/10/12/16/20.dp`).
- Prefer section grouping via spacing/dividers before adding card containers.
- Use elevation sparingly; only where interaction hierarchy needs it.

## 4. Layout System

- Base layout: `Box`/`Column` with `WindowInsets.safeDrawing` handling.
- Keep overlays above `AndroidView` content when touch priority matters.
- Structure by intent:
  - status/hero
  - core controls
  - optional advanced controls
- Prefer rails/dividers over card stacks.

## 5. Compose Architecture Rules

- State hoisting:
  - durable state in `MainViewModel`
  - composables receive state + callbacks
- Composable APIs:
  - include `modifier: Modifier = Modifier`
  - avoid hidden global state
- Side effects:
  - use `LaunchedEffect` / activity result APIs
  - no blocking work in composition
- Recomposition hygiene:
  - `remember`/derived values for computed UI state
  - avoid allocating heavy objects on every recomposition

## 6. Component Rules

### Primary / secondary actions

- One dominant primary action per context.
- Secondary actions visibly lower emphasis.
- Avoid duplicate actions that perform the same deterministic step.

### Inputs + controls

- Clear labels + concise helper text.
- Keep compact fields side-by-side only when both are short and related.
- Advanced settings collapsed by default.

### WebView and mixed UI

- Keep WebView behavior encapsulated in `AndroidView` wrappers.
- Guard verbose logs and diagnostics behind `BuildConfig.DEBUG`.

## 7. Copy Style

- Short, operational, direct.
- One helper sentence when possible.
- No repeated status messaging in multiple UI regions.
- Remove filler subtitles that do not change user action.

## 8. Accessibility + Usability

- Touch targets >= 44dp where practical.
- Do not rely on color alone for state.
- Provide meaningful `contentDescription` for icon-only controls.
- Preserve contrast for status, secondary text, and disabled states.

## 9. Anti-Patterns (Do Not Add)

- Hardcoded theme values sprinkled across screens.
- Business/network logic inside composables.
- Card-inside-card nesting for simple layout.
- Duplicate status pills/header messages for same state.
- Long unbounded helper prose under every control.

## 10. New Screen Checklist

1. Uses shared theme primitives (`MaterialTheme`, existing helpers), no random style constants.
2. Keeps durable state in ViewModel; UI is state + callbacks.
3. Has one clear primary action.
4. Uses spacing/divider-led hierarchy; cards only when needed.
5. Advanced controls collapsed by default.
6. Copy is concise; no duplicate status text.
7. Insets and touch targets are correct.
8. `./gradlew :app:lintDebug` passes.
9. `./gradlew :app:testDebugUnitTest` passes for touched logic.
10. Visual check on API 35 phone emulator and API 31 compatibility emulator.
