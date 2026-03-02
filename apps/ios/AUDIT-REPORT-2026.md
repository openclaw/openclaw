# OpenClaw iOS App - Comprehensive Audit Report 2026

**Date:** 2026-03-02
**Scope:** `apps/ios/Sources/` (63 files, ~16,244 LOC), `apps/ios/Tests/` (25 files, 1,884 LOC)
**Deployment Target:** iOS 18.0 / watchOS 11.0 | Swift 6.0 (strict concurrency: complete)
**Audit Team:** 5 specialized Opus 4.6 agents (Concurrency, API Modernization, Architecture, UI/UX, Security)

---

## Executive Summary

The OpenClaw iOS app is a **well-engineered codebase** that has adopted many 2026 best practices: Swift 6 strict concurrency, the Observation framework (`@Observable`), `NavigationStack`, Keychain credential storage, and TLS certificate pinning. However, the audit identified **9 critical findings**, **17 high findings**, **29 medium findings**, and **25 low findings** across 5 audit domains.

### Overall Health Score: **B+** (74/100)

| Domain | Score | Grade | Key Issue |
|--------|-------|-------|-----------|
| Swift 6 Concurrency | 78/100 | B+ | 3 data race risks, 5 unsafe patterns |
| iOS 26 API Modernization | 82/100 | A- | 1 deprecated framework, 4 dead code paths |
| Architecture & Code Quality | 62/100 | C+ | 2 god objects, 11.6% test coverage ratio |
| UI/UX & Accessibility | 65/100 | C+ | Zero Dynamic Type, zero localization |
| Security & Performance | 85/100 | A | No critical vulns, 3 high storage issues |

---

## Critical Findings (9)

### Concurrency (3)

| ID | Finding | File | Risk |
|----|---------|------|------|
| CON-C1 | `GatewayTLSFingerprintProbe` data race: `objc_sync_enter` with unsynchronized `didFinish`/`session`/`task` reads in `start()` | `Gateway/GatewayConnectionController.swift:992-1058` | Crash/undefined behavior |
| CON-C2 | `PhotoCaptureDelegate` & `MovieFileDelegate` unsynchronized `didResume` flag can double-resume `CheckedContinuation` | `Camera/CameraController.swift:260-339` | Fatal crash (debug), UB (release) |
| CON-C3 | `GatewayDiagnostics.logWritesSinceCheck` uses `nonisolated(unsafe)` suppressing all compiler race checks | `Gateway/GatewaySettingsStore.swift:358` | Silent data race |

### Architecture (2)

| ID | Finding | File | Risk |
|----|---------|------|------|
| ARC-C1 | `NodeAppModel` is a 2,787 LOC god object with ~17 responsibilities | `Model/NodeAppModel.swift` | Untestable, unmaintainable |
| ARC-C2 | `TalkModeManager` is a 2,153 LOC god object centralizing speech, audio, PTT, and gateway comms | `Voice/TalkModeManager.swift` | Same as above |

### UI/UX (3)

| ID | Finding | File | Risk |
|----|---------|------|------|
| UIX-C1 | `RootCanvas` voiceWakeToast animations ignore `accessibilityReduceMotion` | `RootCanvas.swift:159-167` | Accessibility violation |
| UIX-C2 | `TalkOrbOverlay` perpetual pulse animations ignore `accessibilityReduceMotion` | `Voice/TalkOrbOverlay.swift:15-26` | Vestibular disorder risk |
| UIX-C3 | `CameraFlashOverlay` has no VoiceOver announcement and no reduced motion check | `RootCanvas.swift:405-429` | Accessibility violation, photosensitivity |

### API Modernization (1)

| ID | Finding | File | Risk |
|----|---------|------|------|
| API-C1 | `NetService` usage (deprecated since iOS 16, removed in future SDKs) while `NWBrowser` already used for discovery | `Gateway/GatewayServiceResolver.swift`, `Gateway/GatewayConnectionController.swift:560-657` | Future SDK breakage |

---

## High Findings (17)

### Concurrency (5)

| ID | Finding | File |
|----|---------|------|
| CON-H1 | `ScreenRecordService` `UncheckedSendableBox<T>` wraps any T as Sendable, silencing compiler | `Screen/ScreenRecordService.swift:4-11` |
| CON-H2 | `WatchMessagingService` `@unchecked Sendable` with `WCSession` property reads unprotected | `Services/WatchMessagingService.swift:23-28` |
| CON-H3 | `LocationService` stores `CheckedContinuation` as instance vars with `nonisolated` delegate callbacks hopping to `@MainActor` | `Location/LocationService.swift:13-14` |
| CON-H4 | `LiveNotificationCenter` wraps non-Sendable `UNUserNotificationCenter` in `@unchecked Sendable` | `Services/NotificationService.swift:18-58` |
| CON-H5 | `NetworkStatusService` is `@unchecked Sendable` but stateless - unnecessary annotation | `Device/NetworkStatusService.swift:5` |

### Security (3)

| ID | Finding | File |
|----|---------|------|
| SEC-H1 | TLS fingerprints stored in UserDefaults (backup-extractable trust anchor) | `OpenClawKit/GatewayTLSPinning.swift:19-38` |
| SEC-H2 | `KeychainStore` update path doesn't enforce `kSecAttrAccessible` on existing items | `Gateway/KeychainStore.swift:20-37` |
| SEC-H3 | Gateway connection metadata (host/port/topology) in UserDefaults | `Gateway/GatewaySettingsStore.swift:170-217` |

### Architecture (2)

| ID | Finding | File |
|----|---------|------|
| ARC-H1 | 3 oversized files: `GatewayConnectionController` (1,058 LOC), `SettingsTab` (1,032 LOC), `OnboardingWizardView` (884 LOC) | Various |
| ARC-H2 | 17 source modules with zero test coverage; 11.6% test LOC ratio | See gap analysis |

### UI/UX (5)

| ID | Finding | File |
|----|---------|------|
| UIX-H1 | Zero Dynamic Type support (no `@ScaledMetric`, no `dynamicTypeSize`) | All view files |
| UIX-H2 | Zero localization infrastructure (all hardcoded English) | All source files |
| UIX-H3 | Zero haptic feedback in entire app | All source files |
| UIX-H4 | OnboardingWizardView missing accessibility labels on mode selection rows | `Onboarding/OnboardingWizardView.swift` |
| UIX-H5 | `GatewayTrustPromptAlert` and `DeepLinkAgentPromptAlert` use deprecated `Alert` API | `Gateway/GatewayTrustPromptAlert.swift` |

### API Modernization (2)

| ID | Finding | File |
|----|---------|------|
| API-H1 | Dead `#available(iOS 15/18)` checks (deployment target is iOS 18.0) | `OpenClawApp.swift:344`, `Camera/CameraController.swift:222-249` |
| API-H2 | `UNUserNotificationCenter` callback APIs wrapped in continuations instead of native async | `OpenClawApp.swift:429-462` |

---

## Cross-Cutting Themes

### 1. God Object Pattern
`NodeAppModel` (2,787 LOC) and `TalkModeManager` (2,153 LOC) together represent **30%** of the entire codebase. Both have `// swiftlint:disable` suppressions acknowledging the problem. This is the single highest-impact improvement opportunity.

### 2. Inconsistent Synchronization Primitives
The codebase uses 4 different synchronization mechanisms: `NSLock` (6 usages), `OSAllocatedUnfairLock` (1 usage), `objc_sync_enter/exit` (1 usage), and `DispatchQueue` serialization (7 usages). Standardizing on `OSAllocatedUnfairLock` + actors would improve consistency and safety.

### 3. UserDefaults Overuse
~70+ direct `UserDefaults.standard` reads/writes with raw string keys across the codebase. TLS fingerprints, gateway metadata, and connection details stored in UserDefaults should be in Keychain. Non-sensitive preferences lack a typed key registry.

### 4. Missing Accessibility Infrastructure
Dynamic Type, localization, and haptic feedback are completely absent. Three views ignore `accessibilityReduceMotion`. This represents the largest gap relative to Apple's 2026 HIG expectations.

### 5. Test Coverage Gaps
11.6% test LOC ratio with 17 untested modules. The gateway reconnect state machine (most complex logic), background lifecycle, onboarding flow, and TalkModeManager have minimal or zero test coverage.

---

## Test Coverage Gap Analysis (Top 15 Gaps)

| Module | Source LOC | Test LOC | Coverage |
|--------|-----------|----------|----------|
| `NodeAppModel.swift` | 2,787 | 478 (invoke only) | Partial - reconnect/background/deep links untested |
| `TalkModeManager.swift` | 2,153 | 31 (config only) | Minimal |
| `GatewayConnectionController.swift` | 1,058 | 226 | Partial - no TLS/Bonjour/autoconnect tests |
| `SettingsTab.swift` | 1,032 | 8 (smoke) | Smoke only |
| `OnboardingWizardView.swift` | 884 | 0 | None |
| `OpenClawApp.swift` | 541 | 0 | None |
| `RootCanvas.swift` | 429 | 8 (smoke) | Smoke only |
| `GatewayOnboardingView.swift` | 371 | 0 | None |
| `WatchMessagingService.swift` | 284 | 0 | None |
| `ContactsService.swift` | 210 | 0 | None |
| `LocationService.swift` | 177 | 0 | None |
| `PhotoLibraryService.swift` | 164 | 0 | None |
| `CalendarService.swift` | 135 | 0 | None |
| `RemindersService.swift` | 133 | 0 | None |
| `MotionService.swift` | 100 | 0 | None |

---

## Prioritized Action Plan

### Phase 1: Critical Fixes (Immediate)

| # | Action | Effort | Impact |
|---|--------|--------|--------|
| 1 | Fix `PhotoCaptureDelegate`/`MovieFileDelegate` `didResume` synchronization (CON-C2) | Small | Prevents crashes |
| 2 | Fix `GatewayTLSFingerprintProbe` data race (CON-C1) | Small | Prevents undefined behavior |
| 3 | Add `accessibilityReduceMotion` checks to `RootCanvas` and `TalkOrbOverlay` (UIX-C1, C2, C3) | Small | Accessibility compliance |
| 4 | Replace `nonisolated(unsafe)` in `GatewayDiagnostics` (CON-C3) | Small | Compiler safety |

### Phase 2: High-Priority Improvements (Next Sprint)

| # | Action | Effort | Impact |
|---|--------|--------|--------|
| 5 | Move TLS fingerprints to Keychain (SEC-H1) | Medium | Security hardening |
| 6 | Fix `KeychainStore` update accessibility enforcement (SEC-H2) | Small | Security correctness |
| 7 | Migrate `NetService` to Network framework (API-C1) | Large | Future-proofing |
| 8 | Remove dead `#available` checks (API-H1) | Small | Code cleanup |
| 9 | Replace `UNUserNotificationCenter` callbacks with async APIs (API-H2) | Small | Modernization |
| 10 | Add `@ScaledMetric` Dynamic Type support to key views (UIX-H1) | Medium | Accessibility |

### Phase 3: Architecture Refactoring (Planned)

| # | Action | Effort | Impact |
|---|--------|--------|--------|
| 11 | Split `NodeAppModel` into 5-6 focused types (ARC-C1) | Large | Testability, maintainability |
| 12 | Split `TalkModeManager` into 3-4 focused types (ARC-C2) | Large | Same |
| 13 | Extract `SettingsTab` into section sub-views (ARC-H1) | Medium | Maintainability |
| 14 | Create typed UserDefaults key registry | Medium | Type safety |
| 15 | Add test coverage for gateway reconnect state machine | Large | Regression safety |
| 16 | Add test coverage for background lifecycle management | Medium | Regression safety |

### Phase 4: Polish & Hardening (Opportunistic)

| # | Action | Effort | Impact |
|---|--------|--------|--------|
| 17 | Add localization infrastructure with `String(localized:)` (UIX-H2) | Large | International users |
| 18 | Add haptic feedback to key interactions (UIX-H3) | Small | UX polish |
| 19 | Standardize on `OSAllocatedUnfairLock` across codebase | Small | Consistency |
| 20 | Replace Combine `Timer.publish`/`onReceive` with async patterns | Small | Modernization |
| 21 | Add keyboard shortcuts for iPad (UIX-M5) | Small | iPad UX |
| 22 | Gate `ELEVENLABS_API_KEY` env var behind `#if DEBUG` (SEC-M3) | Small | Security |
| 23 | Enforce minimum interval between deep link prompts (SEC-M5) | Small | Security |
| 24 | Add HMAC verification to QR setup codes (SEC-M6) | Medium | Security |

---

## Positive Patterns Worth Preserving

1. **Observation framework adoption** - Zero `ObservableObject` usage; consistent `@Observable` + `@Environment` throughout
2. **Protocol-based DI** - `NodeServiceProtocols.swift` defines clean interfaces for all device capabilities with default implementations
3. **Keychain for credentials** - Tokens, passwords, instance IDs stored with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`
4. **TLS certificate pinning** - TOFU model with SHA-256 fingerprint verification and user confirmation
5. **`CameraController` as actor** - Exemplary Swift concurrency pattern for hardware resource management
6. **Dual WebSocket sessions** - Node/operator separation provides good privilege scoping
7. **Non-persistent WKWebView** - Canvas prevents session data leakage
8. **Swift 6 strict concurrency** - Enabled project-wide with `SWIFT_STRICT_CONCURRENCY: complete`
9. **`@Sendable` service protocols** - All service protocols correctly require `Sendable` conformance
10. **Deep link confirmation** - Agent deep links require explicit user approval with length limits

---

## OWASP Mobile Top 10 Summary

| Category | Status |
|----------|--------|
| M1: Improper Credential Usage | PASS |
| M2: Inadequate Supply Chain Security | PASS |
| M3: Insecure Authentication/Authorization | PASS |
| M4: Insufficient Input/Output Validation | PASS |
| M5: Insecure Communication | PASS (note: HTTP allowed in web views) |
| M6: Inadequate Privacy Controls | PASS (note: location sent over TLS) |
| M7: Insufficient Binary Protections | N/A |
| M8: Security Misconfiguration | PASS (notes: H-1, H-3) |
| M9: Insecure Data Storage | PASS (notes: H-1, H-3, M-2) |
| M10: Insufficient Cryptography | PASS |

---

## Detailed Reports

Individual audit reports with full code snippets and line-by-line analysis:

- [`audit-concurrency.md`](./audit-concurrency.md) - Swift 6 strict concurrency (20 findings)
- [`audit-api-modernization.md`](./audit-api-modernization.md) - iOS 26 API modernization (19 findings)
- [`audit-architecture.md`](./audit-architecture.md) - Architecture & test coverage (16 findings)
- [`audit-uiux.md`](./audit-uiux.md) - UI/UX & accessibility (24 findings)
- [`audit-security.md`](./audit-security.md) - Security & performance (18 findings)

---

*Generated by OpenClaw iOS Audit Team (5x Opus 4.6 agents) on 2026-03-02*
