# iOS App UI/UX & Accessibility Audit

**Audit Date:** 2026-03-02
**Scope:** All SwiftUI view files in `apps/ios/Sources/`
**Reference Standards:** Apple HIG (iOS 26), WCAG 2.1 AA, Liquid Glass design language, SwiftUI accessibility best practices

---

## UI/UX Health Overview

The OpenClaw iOS app demonstrates a well-structured SwiftUI codebase with several accessibility-conscious patterns already in place. The app uses the modern `@Observable` / `Observation` framework consistently, respects `accessibilityReduceMotion`, responds to `colorSchemeContrast`, and provides accessibility labels on key interactive elements. However, there are significant gaps in Dynamic Type support, localization readiness, haptic feedback, and iPad adaptivity that should be addressed before the next major release.

**Strengths:**
- Good use of `@Environment(\.accessibilityReduceMotion)` in animation-heavy views (RootTabs, StatusPill)
- `StatusGlassCard` correctly responds to `colorSchemeContrast` for increased visibility
- `StatusPill` has proper `accessibilityLabel`, `accessibilityValue`, and `accessibilityHint`
- `TalkOrbOverlay` uses `accessibilityElement(children: .combine)` to present a single VoiceOver element
- Consistent use of `@Observable` macro (Observation framework) over legacy `ObservableObject`
- Glass material effects on overlays (`.ultraThinMaterial`) with light/dark mode awareness

**Weaknesses:**
- Zero Dynamic Type support (no `@ScaledMetric`, no `dynamicTypeSize` environment usage)
- Zero localization infrastructure (no `NSLocalizedString`, `String(localized:)`, or `.strings` files)
- Zero haptic feedback across the entire app
- Several views lack accessibility labels entirely
- Hardcoded dimensions in TalkOrbOverlay will break on small screens
- SettingsTab is a monolithic ~650 LOC file
- No iPad-specific layout adaptations
- `RootCanvas` voiceWakeToast animation does not respect `reduceMotion` (unlike `RootTabs`)

---

## Critical Findings

### C-1: RootCanvas animations ignore `accessibilityReduceMotion`

**File:** `Sources/RootCanvas.swift:159-167`
**Description:** The `voiceWakeToastText` animation in `RootCanvas` uses hardcoded `.spring()` and `.easeOut()` animations without checking `@Environment(\.accessibilityReduceMotion)`. The sibling `RootTabs` view correctly guards the same toast animation with `reduceMotion ? .none : .spring(...)`.

**Impact:** Users who require reduced motion will see unexpected animations in the canvas view.

**Recommended Fix:**
```swift
// In RootCanvas, add the environment property:
@Environment(\.accessibilityReduceMotion) private var reduceMotion

// Then guard animations:
withAnimation(self.reduceMotion ? .none : .spring(response: 0.25, dampingFraction: 0.85)) {
    self.voiceWakeToastText = trimmed
}
// ...
withAnimation(self.reduceMotion ? .none : .easeOut(duration: 0.25)) {
    self.voiceWakeToastText = nil
}
```

### C-2: TalkOrbOverlay perpetual animations ignore `accessibilityReduceMotion`

**File:** `Sources/Voice/TalkOrbOverlay.swift:15-26`
**Description:** The pulsing ring animations use `.repeatForever(autoreverses: false)` without checking `reduceMotion`. These are high-frequency, continuous animations that can cause discomfort for users with vestibular disorders.

**Recommended Fix:**
```swift
@Environment(\.accessibilityReduceMotion) private var reduceMotion

// Replace pulse animations with:
if !reduceMotion {
    Circle()
        .scaleEffect(self.pulse ? 1.15 : 0.96)
        .animation(.easeOut(duration: 1.3).repeatForever(autoreverses: false), value: self.pulse)
}
```

### C-3: CameraFlashOverlay has no accessibility announcement

**File:** `Sources/RootCanvas.swift:405-429`
**Description:** `CameraFlashOverlay` flashes the screen white at 85% opacity. VoiceOver users have no indication that a photo was taken. There is no `AccessibilityNotification.Announcement` posted, and the flash itself could trigger photosensitive reactions.

**Recommended Fix:**
```swift
// Post an accessibility announcement:
AccessibilityNotification.Announcement("Photo captured").post()

// Add prefers-reduced-motion check to skip or soften the flash:
if reduceMotion {
    // Skip flash, or use subtle opacity change
}
```

---

## High Findings

### H-1: Zero Dynamic Type support across the entire app

**Files:** All view files in `Sources/`
**Description:** No view uses `@ScaledMetric`, `@Environment(\.dynamicTypeSize)`, or `ContentSizeCategory`. All hardcoded font sizes and dimensions (e.g., `font(.system(size: 16))` in `OverlayButton`, `font(.system(size: 12))` in monospaced debug text, `frame(width: 320, height: 320)` in TalkOrbOverlay) will not scale with the user's preferred text size. Apple's HIG strongly recommends supporting Dynamic Type for all text.

**Key locations:**
- `Sources/RootCanvas.swift:358` - OverlayButton uses fixed `size: 16`
- `Sources/Voice/TalkOrbOverlay.swift:16,23,39` - Fixed 320pt and 190pt circles
- `Sources/Status/StatusPill.swift:52` - Fixed `width: 9, height: 9` indicator dot
- `Sources/Gateway/GatewayDiscoveryDebugLogView.swift:24` - Fixed `font(.callout)`
- `Sources/Gateway/GatewayOnboardingView.swift:345-346` - Fixed `.system(size: 12)` monospaced text

**Recommended Fix:** Use semantic font styles (`.body`, `.headline`, etc.) instead of fixed sizes where possible. For custom dimensions, use `@ScaledMetric`:
```swift
@ScaledMetric(relativeTo: .body) private var orbSize: CGFloat = 190
@ScaledMetric(relativeTo: .caption) private var dotSize: CGFloat = 9
```

### H-2: OnboardingWizardView missing accessibility labels on interactive elements

**File:** `Sources/Onboarding/OnboardingWizardView.swift`
**Description:** Multiple interactive elements lack accessibility labels:
- `OnboardingModeRow` (line 861-884): Radio-style selection buttons have no `accessibilityAddTraits(.isButton)` or clear selection state announcement. VoiceOver users cannot tell which mode is selected.
- Gateway list connect buttons (line 453-465): `ProgressView` and "Resolving..." text lack accessibility context.
- QR scanner action (line 319-326): "Scan QR Code" button label is good, but the status line below it (line 340-345) is not connected as an accessibility value.

**Recommended Fix:**
```swift
// OnboardingModeRow:
.accessibilityElement(children: .combine)
.accessibilityAddTraits(self.selected ? [.isButton, .isSelected] : .isButton)
.accessibilityLabel("\(self.title), \(self.subtitle)")
.accessibilityValue(self.selected ? "Selected" : "Not selected")
```

### H-3: No localization infrastructure

**Files:** All source files
**Description:** The entire app uses hardcoded English strings with no localization wrapping. No `NSLocalizedString`, `String(localized:)`, `.strings`/`.stringsdict` files, or `LocalizedStringKey` usage was found. This makes the app inaccessible to non-English speakers and violates Apple's HIG recommendation to support multiple languages.

**Key examples:**
- `Sources/Settings/SettingsTab.swift`: All section headers, labels, help text
- `Sources/Onboarding/OnboardingWizardView.swift`: "Welcome", "Connected", all step descriptions
- `Sources/Status/StatusPill.swift`: "Connected", "Connecting...", "Error", "Offline"
- `Sources/Voice/VoiceTab.swift`: All list labels

**Recommended Fix:** Wrap all user-facing strings in `String(localized:)` or use `LocalizedStringResource`. Create a `Localizable.xcstrings` catalog.

### H-4: No haptic feedback anywhere in the app

**Files:** All source files
**Description:** No `UIImpactFeedbackGenerator`, `UINotificationFeedbackGenerator`, `UISelectionFeedbackGenerator`, or `.sensoryFeedback()` modifier usage found. Key interaction points that would benefit from haptics:
- Gateway connection success/failure
- Voice wake trigger detection
- Talk mode orb tap
- QR code successfully scanned
- Toggle state changes in Settings

**Recommended Fix:**
```swift
// iOS 17+ SwiftUI modifier:
.sensoryFeedback(.success, trigger: appModel.gatewayServerName != nil)

// For Talk orb tap:
.sensoryFeedback(.impact(weight: .medium), trigger: tapCount)
```

### H-5: GatewayTrustPromptAlert uses deprecated `Alert` API

**File:** `Sources/Gateway/GatewayTrustPromptAlert.swift:17-35`
**Description:** Uses the deprecated `Alert(title:message:primaryButton:secondaryButton:)` initializer pattern. This API was deprecated in iOS 15 in favor of the `alert(_:isPresented:actions:message:)` modifier. Same issue in `DeepLinkAgentPromptAlert.swift:15-33`.

**Recommended Fix:** Migrate to the modern `alert` modifier with `@ViewBuilder` actions.

---

## Medium Findings

### M-1: SettingsTab is a monolithic view (~650+ LOC)

**File:** `Sources/Settings/SettingsTab.swift`
**Description:** SettingsTab contains the entire settings UI, including gateway connection, device features, advanced debug options, agent picker, and reset logic. The file has a `// swiftlint:disable type_body_length` comment acknowledging this. This makes the view hard to maintain and test.

**Recommended Fix:** Extract into focused sub-views:
- `GatewaySettingsSection`
- `DeviceFeaturesSection`
- `AdvancedSettingsSection`
- `DeviceInfoSection`

### M-2: No empty states for VoiceTab when disconnected

**File:** `Sources/Voice/VoiceTab.swift`
**Description:** VoiceTab always shows the same status labels regardless of gateway connection state. When disconnected, it should show a clear empty state explaining that voice features require a gateway connection, with a CTA to connect.

**Recommended Fix:**
```swift
if appModel.gatewayServerName == nil {
    ContentUnavailableView(
        "Not Connected",
        systemImage: "antenna.radiowaves.left.and.right.slash",
        description: Text("Connect to a gateway to use voice features."))
}
```

### M-3: No loading/error states in GatewayQuickSetupSheet

**File:** `Sources/Gateway/GatewayQuickSetupSheet.swift`
**Description:** When `bestCandidate` is nil and no gateways are found, the sheet shows a text message but no visual indicator that discovery is actively running. No retry button or activity indicator is shown during the discovery phase.

### M-4: OverlayButton touch target may be too small

**File:** `Sources/RootCanvas.swift:348-403`
**Description:** `OverlayButton` uses `padding(10)` around a 16pt icon, resulting in a ~36pt touch target. Apple HIG recommends a minimum of 44pt x 44pt for touch targets.

**Recommended Fix:**
```swift
.frame(minWidth: 44, minHeight: 44)
// or increase padding to at least 14pt
```

### M-5: No keyboard shortcut support

**Files:** All view files
**Description:** No `.keyboardShortcut()` modifiers found anywhere. iPad users with external keyboards have no keyboard navigation shortcuts for common actions like opening chat, settings, or toggling voice.

### M-6: TalkOrbOverlay hardcoded dimensions break on small screens

**File:** `Sources/Voice/TalkOrbOverlay.swift:16,23,39`
**Description:** The pulse rings are hardcoded at 320pt width/height, and the inner orb at 190pt. On iPhone SE (320pt logical width), the rings will extend beyond screen bounds. On iPad, the orb will appear relatively small.

**Recommended Fix:** Use `GeometryReader` or `@ScaledMetric` for adaptive sizing:
```swift
GeometryReader { proxy in
    let size = min(proxy.size.width, proxy.size.height) * 0.65
    Circle().frame(width: size, height: size)
}
```

### M-7: ScreenTab error overlay not accessible

**File:** `Sources/Screen/ScreenTab.swift:12-21`
**Description:** The error text overlay appears only when `errorText` is set and the gateway is disconnected, but there is no VoiceOver announcement when the error appears or disappears. Screen reader users may not notice the error.

### M-8: No pull-to-refresh on any list view

**Files:** `Sources/Voice/VoiceTab.swift`, `Sources/Gateway/GatewayDiscoveryDebugLogView.swift`
**Description:** List views do not support `.refreshable {}` for pull-to-refresh, which is a standard iOS interaction pattern.

---

## Low Findings

### L-1: Inconsistent glass card styling between RootTabs and RootCanvas

**Files:** `Sources/RootTabs.swift`, `Sources/RootCanvas.swift`
**Description:** `RootTabs` shows `StatusPill` without the `brighten` parameter (defaults to false), while `RootCanvas.CanvasContent` passes `brighten` based on color scheme. This can cause visual inconsistency if both code paths are reachable.

### L-2: VoiceWakeToast hardcoded top offset

**Files:** `Sources/RootTabs.swift:47`, `Sources/RootCanvas.swift:329`
**Description:** `.safeAreaPadding(.top, 58)` is a magic number that assumes the StatusPill height. If the pill height changes (e.g., with Dynamic Type), the toast will overlap.

### L-3: No app-wide tint/accent color configuration

**Files:** `Sources/OpenClawApp.swift`
**Description:** No `.tint()` or `accentColor` is set at the app level. The default blue accent is used for buttons and toggles, but the app uses `appModel.seamColor` for some elements. This creates visual inconsistency.

### L-4: ConnectionStatusBox uses hardcoded monospaced font size

**File:** `Sources/Onboarding/GatewayOnboardingView.swift:345-346`
**Description:** `.font(.system(size: 12, weight: .regular, design: .monospaced))` will not scale with Dynamic Type.

### L-5: DateFormatter instances in GatewayDiscoveryDebugLogView are not locale-aware

**File:** `Sources/Gateway/GatewayDiscoveryDebugLogView.swift:49-53`
**Description:** `DateFormatter` with hardcoded `dateFormat = "HH:mm:ss"` does not respect the user's locale for time formatting. Should use `.dateStyle`/`.timeStyle` or `formatted()`.

### L-6: No transition animations on sheet presentations

**File:** `Sources/RootCanvas.swift:92-111`
**Description:** The `.sheet(item:)` presentations for settings, chat, and quick setup use default sheet transitions. Custom `presentationDetents` could improve the UX for smaller sheets like Quick Setup.

### L-7: Onboarding wizard duplicate padding

**File:** `Sources/Onboarding/OnboardingWizardView.swift:344-346`
**Description:** The welcome step has duplicate `.padding(.horizontal, 24)` on the status line (lines 344 and 345), which doubles the intended padding.

### L-8: No VoiceOver rotor actions

**Files:** All view files
**Description:** No `.accessibilityAction(named:)` or custom rotor items are defined. Power VoiceOver users could benefit from custom actions for common operations.

---

## Accessibility Compliance Checklist

| Criterion | Status | Notes |
|---|---|---|
| VoiceOver labels on all interactive elements | Partial | Overlay buttons, StatusPill, ChatSheet close, SettingsTab close have labels. OnboardingModeRow, gateway list items, many settings toggles missing. |
| VoiceOver hints for non-obvious actions | Partial | StatusPill has hint. Most buttons lack hints. |
| VoiceOver value for stateful elements | Partial | StatusPill has value. Toggle states auto-announced by SwiftUI. OnboardingModeRow selection not announced. |
| Dynamic Type support | Missing | No `@ScaledMetric`, no `dynamicTypeSize` environment, fixed font sizes throughout. |
| Reduce Motion respected | Partial | RootTabs and StatusPill respect it. RootCanvas, TalkOrbOverlay, CameraFlashOverlay do not. |
| Increased Contrast support | Partial | StatusGlassCard adjusts border for increased contrast. Other views do not check. |
| Color not sole indicator | Pass | Status uses both color dots and text labels. |
| Minimum touch target 44pt | Partial | Standard buttons OK. OverlayButton (~36pt) and StatusPill dot are undersized. |
| Keyboard navigation (iPad) | Missing | No keyboard shortcuts defined. |
| Localization readiness | Missing | All strings hardcoded in English. |
| Haptic feedback | Missing | No haptic feedback in any interaction. |
| iPad layout adaptation | Missing | No `horizontalSizeClass` or iPad-specific layouts. |
| Dark mode support | Pass | Uses semantic colors, materials, and `.preferredColorScheme(.dark)` for canvas. |
| Safe area handling | Pass | Correct use of `.ignoresSafeArea()` for screen, `.safeAreaPadding()` for overlays. |
| Error state announcements | Missing | No `AccessibilityNotification.Announcement` for state changes. |
| Focus management | Partial | `@FocusState` used in VoiceWakeWordsSettingsView. No focus management in onboarding. |

---

## Summary by Priority

| Priority | Count | Key Themes |
|---|---|---|
| Critical | 3 | Reduce Motion violations, flash accessibility |
| High | 5 | Dynamic Type, localization, haptics, deprecated APIs, missing labels |
| Medium | 8 | Monolithic views, empty states, touch targets, iPad, hardcoded sizes |
| Low | 8 | Styling consistency, magic numbers, locale formatting, polish |
