---
summary: A contract-first Kotlin Multiplatform migration plan for sharing OpenClaw mobile logic while preserving native Android and iOS UI.
title: Native UI mobile KMP migration plan
read_when:
  - Planning shared Android and iOS mobile business logic
  - Refactoring apps/android or apps/shared/OpenClawKit
  - Designing Swift-friendly Kotlin Multiplatform APIs
  - Reviewing mobile code-reduction or cross-platform parity work
---

## Status

Proposed. This is a migration plan, not an approval for a broad rewrite.

Kotlin Multiplatform is a good fit for OpenClaw's duplicated, deterministic
mobile domain logic. It is not a fit for a shared UI rewrite. Android keeps
Jetpack Compose and iOS keeps SwiftUI, Swift concurrency, Xcode project
ownership, and Apple framework integrations.

No KMP foundation-only PR should merge. The first implementation PR must both
introduce the minimal build bridge and delete a larger amount of replaced
production logic while preserving the contract described below.

## Decision

Create one small KMP module under the existing Android Gradle root:

```text
apps/android/
  mobile-core/                 # commonMain domain and protocol decisions
    src/commonMain/
    src/commonTest/
    src/androidMain/            # only unavoidable Android adapters
    src/iosMain/                # only unavoidable Apple adapters
apps/ios/
  OpenClawMobile/               # local SwiftPM facade over the KMP XCFramework
```

The Android app consumes `:mobile-core` as a normal Gradle dependency. The
iOS app consumes a local Swift package generated from the KMP XCFramework.
`OpenClawMobile` is the only Swift-facing import for migrated features; the
generated Kotlin framework stays an implementation detail.

This keeps one Gradle wrapper and version catalog, rather than creating a
second mobile build system. The current Android toolchain already uses Kotlin
2.4.0 and Gradle 9.6.1, so the initial work should prove compatibility against
that toolchain instead of adding an unrelated upgrade.

## What stays native

These areas remain platform-owned unless a later slice can prove a narrow,
value-preserving boundary:

- All UI, navigation, accessibility, localization presentation, and lifecycle
  coordination.
- Camera, microphone, speech recognition, WebRTC, screen capture, widgets,
  WatchConnectivity, notifications, background execution, and OS permissions.
- Keychain/Keystore access, app-group storage, Room, file locations, and
  platform-specific migration mechanics.
- WebSocket transport ownership while reconnect timing, foreground/background
  policy, certificate APIs, or native diagnostics remain different.

The existing Swift package is also used outside the iOS app. A slice may delete
Swift code only after every current consumer has either moved to the shared
contract or intentionally remains on a platform adapter. macOS and Apple Watch
behavior must not be collateral damage from an iOS/Android refactor.

## Evidence and migration order

The repository has substantial overlap, but it is not all equivalent. The
table distinguishes good initial candidates from logic that is still coupled to
the platform boundary.

| Surface                                                                   | Current implementations                                                                                                                                | Assessment                                                                                                                   | Migration order                                                    |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Talk directive parsing                                                    | `apps/android/app/src/main/java/ai/openclaw/app/voice/TalkDirectiveParser.kt`; `apps/shared/OpenClawKit/Sources/OpenClawKit/TalkDirective.swift`       | Nearly the same rules and data model, but leading blank-line handling and `seed` width differ.                               | Characterize first; likely first slice.                            |
| Bonjour escape decoding                                                   | `apps/android/app/src/main/java/ai/openclaw/app/gateway/BonjourEscapes.kt`; `apps/shared/OpenClawKit/Sources/OpenClawKit/BonjourEscapes.swift`         | Shared purpose but different semantics: Android decodes decimal UTF-8 bytes; Swift converts each escape to a Unicode scalar. | Separate compatibility decision before migration.                  |
| Talk configuration parsing                                                | `apps/android/app/src/main/java/ai/openclaw/app/voice/TalkModeGatewayConfig.kt`; `apps/shared/OpenClawKit/Sources/OpenClawKit/TalkConfigParsing.swift` | High-value pure parsing and normalization, with platform bridges around it.                                                  | First or second slice after fixture parity.                        |
| Gateway models, authentication payloads, endpoint identity, TLS decisions | Android gateway classes; `OpenClawKit` gateway helpers                                                                                                 | Mostly domain/protocol work, but trust prompts and secure persistence are platform concerns.                                 | Second tranche, using injected platform ports.                     |
| Chat transcript, outbox, and session policy                               | Android `chat/` classes; `OpenClawChatUI`                                                                                                              | Large duplication opportunity, but offline storage and UI event timing are intertwined.                                      | Only after a stable core and contract fixtures exist.              |
| Gateway session and node runtime                                          | Android `GatewaySession` and `NodeRuntime`; Swift `GatewayNodeSession` and `NodeAppModel`                                                              | Largest potential saving, but also the highest protocol, lifecycle, and hardware risk.                                       | Last; split transport, state reduction, and device adapters first. |
| Voice mode                                                                | Android and Swift `TalkModeManager`                                                                                                                    | Shares policy but depends heavily on audio, speech, background, and realtime APIs.                                           | Keep native; extract only pure parser/policy functions.            |

The two highlighted differences are blockers, not incidental cleanup. A shared
implementation must not silently choose either platform's behavior. Each needs
a documented canonical rule, a focused compatibility change if necessary, and
separate review from the KMP extraction.

## Target boundaries

`mobile-core` owns only deterministic, side-effect-free rules and narrow
domain types. Its first public Kotlin surface should be intentionally small:

- Parsing and normalization results represented by immutable data classes.
- Validation and policy decisions represented by closed result types.
- Protocol value codecs that do not open sockets, read storage, or request
  permissions.
- Interfaces for the few genuinely platform-owned operations, introduced only
  when a later domain service needs them.

The module must not expose Android framework types, Swift/Foundation types,
Compose state, SwiftUI state, raw JSON trees, a persistence implementation, or
the generated KMP API as an application-facing contract.

Platform code follows a simple direction:

```text
Jetpack Compose / SwiftUI
        -> platform view model or controller
        -> OpenClawMobile Swift facade or :mobile-core Kotlin API
        -> pure common domain rules
        -> injected platform capability when required
```

No runtime fallback or dual implementation is allowed after a slice moves. A
failed rollout is reverted as a whole commit; it is not handled by retaining a
second production decision path.

## Swift API policy

Use SKIE for the generated interop layer and retain a hand-written Swift
facade. This is the stable choice today:

- Kotlin's Swift Export is Alpha and its documentation lists compatibility and
  type-system limitations. It is not the production boundary for this plan.
- SKIE improves Kotlin `suspend` and `Flow` consumption in Swift, but generated
  symbols still do not define the public Swift API.
- The facade owns `Sendable` value types, `LocalizedError` mapping, Swift
  naming, and `async`/`await` entry points. It exposes `AsyncSequence` or
  `AsyncStream` only where an actual stream is part of the product contract.
- Stateful shared services are wrapped by a Swift `actor` when actor isolation
  is the natural iOS contract. Pure functions remain simple Swift value APIs;
  they do not gain an actor merely to hide Kotlin.
- The generated framework is a local SwiftPM binary target in development.
  This app-internal integration does not require a hosted binary package or a
  new publishing system.

The public Swift symbol graph stays small and intentional: a KMP core remains
shared, while a deliberately small Swift package hides generated Kotlin symbols
behind a native Swift API. An ABI gate requires an explicit Swift parity
decision whenever an exposed KMP ABI changes.

## Contract-first rollout

Each tranche follows this sequence. Do not begin the next tranche before the
previous one is merged and stable.

1. **Inventory and characterize.** Identify the Android implementation, every
   Swift implementation and consumer, relevant protocol contract, and existing
   unit tests. Add shared test fixtures for normal, malformed, boundary, and
   Unicode input. Record intentional behavior differences as separate issues.
2. **Choose the canonical behavior.** Use the Gateway protocol or existing
   shipped behavior as the authority. Do not use whichever implementation is
   shorter as the tie-breaker.
3. **Move a complete pure slice.** Add the smallest KMP surface, route both
   platforms through it, and delete the replaced implementation and obsolete
   tests in the same PR.
4. **Validate both consumers.** Run common KMP tests, focused Android unit
   tests and app assembly, plus the matching Xcode tests and an iOS app build.
   Exercise a real protocol path when a moved rule affects connection, pairing,
   authentication, or message delivery.
5. **Lock the boundary.** Use explicit Kotlin API declarations and native KLIB
   ABI baselines for the exported KMP surface. An ABI change must include either
   a Swift facade/test/doc update or a concise recorded decision that it is not
   part of the Swift contract.

The first merged extraction should group enough already-characterized pure
logic to pay for KMP integration. A likely tranche is Talk directive parsing,
Talk configuration normalization, and other proven protocol value helpers; it
must exclude the Bonjour behavior discrepancy until that discrepancy is fixed
on its own merits.

## Net-negative gate

The user's heuristic is a merge gate, not an aspiration:

- For each implementation PR, production additions minus production deletions
  must be less than zero. Count Gradle, KMP, Swift facade, platform adapter,
  and build-integration lines as production additions.
- Tests, docs, generated Xcode output, and ABI baselines are reported
  separately and do not conceal production growth.
- A build-only or wrapper-only KMP PR fails this gate. Combine the bridge with
  a sufficiently complete deletion tranche, or keep the experiment local.
- The PR body records the before/after production line totals and names the
  removed files or sections. Run `git diff --numstat` before review and after
  any review-driven change.

Negative line count is necessary, not sufficient. A smaller diff that adds a
second ownership path, weakens Swift ergonomics, or changes a shipped behavior
does not qualify.

## Required verification

Every migration PR needs a compact evidence map covering the changed common
logic, Android caller, Swift caller, platform adapters, existing tests, and
Gateway protocol behavior. The minimum proof is:

- Common Kotlin tests for the migrated rules and their contract fixtures.
- Focused Android unit tests plus `pnpm android:test` or the smallest expanded
  Gradle target that covers the updated module; assemble the Play debug app
  when linking or packaging changes.
- Focused Xcode tests for the matching iOS behavior plus `pnpm ios:build` or
  the smallest equivalent generated-project build.
- A Swift facade compile/test that proves no app code imports generated Kotlin
  symbols directly.
- Focused protocol or live-node proof whenever the moved slice changes pairing,
  gateway identity, authentication, TLS, reconnect, or message semantics.
- A fresh structured review and clean `git diff --check` before the PR is
  updated.

Remote validation follows repository trust policy. A fork PR is untrusted for
credential-hydrated Testbox execution; use the approved secretless path or
upstream-maintainer infrastructure only after the source and exact head are
reviewed.

## Milestones and stop conditions

| Milestone                   | Deliverable                                                               | Must prove                                                                   | Stop when                                                                     |
| --------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 0. Contract map             | Characterization fixtures and documented behavior decisions               | Every first-slice candidate has Android, Swift, test, and protocol evidence. | A behavior difference has no clear authority.                                 |
| 1. First net-negative slice | KMP module, local SwiftPM facade, deleted parser/normalizer code          | Native UI unchanged; Android and iOS fixture parity; app builds link.        | The bridge cannot be made net-negative or creates a generated-type Swift API. |
| 2. Protocol value kernel    | Endpoint, auth, TLS, and gateway decision helpers with platform ports     | Security and pairing tests stay equivalent.                                  | Platform secure storage or trust prompts leak into common code.               |
| 3. Chat domain policy       | Shared transcript/outbox/session reducers, native storage and UI adapters | Offline/reconnect and message identity behavior remain stable.               | Storage requires a dual-read or runtime fallback path.                        |
| 4. Session orchestration    | Shared state machine only, with native transport and lifecycle adapters   | Reconnect, cancellation, backgrounding, and device invocation are proven.    | A transport or lifecycle invariant cannot be expressed through a narrow port. |

At any stop condition, keep the last merged slice, record the blocker, and do
not force additional code into KMP. The desired outcome is one authoritative
business-rule implementation, not maximum Kotlin coverage.

## Research and precedents

- Kotlin recommends incremental, selective sharing and explicitly supports
  native Android and iOS UI while sharing logic: [Kotlin Multiplatform
  guidance](https://kotlinlang.org/docs/multiplatform/build-ios-android-app.html)
  and the [Android KMP codelab](https://developer.android.com/codelabs/kmp-get-started).
- [Swift Export](https://kotlinlang.org/docs/native-swift-export.html) is Alpha;
  its current limitations make it an evaluation track, not this migration's
  production façade.
- [SKIE](https://skie.touchlab.co/) provides the required coroutine and Flow
  ergonomics, including typed `AsyncSequence` bridging.

## Related

- [Android app](/platforms/android)
- [iOS app](/platforms/ios)
- [Gateway protocol](/gateway/protocol)
- [Mobile module source](https://github.com/openclaw/openclaw/tree/main/apps/android)
