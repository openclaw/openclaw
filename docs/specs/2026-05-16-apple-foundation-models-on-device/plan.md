# Plan — Apple Foundation Models on-device bridge

## Approach

Add a `OpenClawLocalLLM` Swift module in `apps/shared/OpenClawKit/Sources/` that exposes a small API (`classifyIntent`, `polishDictation`, `summarize(short:)`) over Apple's Foundation Models framework. The apps call this module on the device-side hot paths (Voice Wake transcript polish, chat input classification) before deciding to invoke the Gateway. Capability detection (`AppleIntelligence.isAvailable`) gates everything; on unsupported devices the module is a no-op stub.

## Steps

1. Add `apps/shared/OpenClawKit/Sources/OpenClawKit/LocalLLM/Capability.swift` — `AppleIntelligenceCapability` check and graceful fallback object.
2. Add `LocalLLM/IntentClassifier.swift` — prompt template + `Intent` enum decoding via `@Generable`/structured output (Foundation Models framework feature).
3. Add `LocalLLM/DictationPolish.swift` — punctuation/capitalization pass; preserves entities like phone numbers/email.
4. Add `LocalLLM/ShortSummary.swift` — opt-in summary; bounded by max input tokens.
5. Wire `IntentClassifier` into `apps/macos/Sources/.../ChatInputCoordinator.swift` and equivalents in iOS so chat commands are detected before the Gateway round-trip.
6. Wire `DictationPolish` after Voice Wake's final transcript and before invoking the Gateway agent.
7. Settings UI: "Use on-device intelligence" toggle (on by default when capable) in macOS preferences + iOS settings screen.
8. Telemetry (local-only): count of on-device hits + savings estimate visible in the macOS debug panel; nothing leaves the device.
9. Docs: `docs/platforms/macos.md` + `docs/platforms/ios.md` note the capability + toggle.

## Dependencies / order

- Step 1 (capability) blocks everything else.
- Steps 2–4 (the three local pipelines) can ship in parallel.
- Steps 5–6 (wiring) depend on 2–4.
- Steps 7–9 (settings + docs) land last.
