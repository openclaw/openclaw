# Validation — Apple Foundation Models on-device bridge

## Automated tests

- `OpenClawKitTests/LocalLLM/IntentClassifierTests.swift` — fixture inputs map to expected `Intent` cases; ≥ 90% on the bundled fixture set.
- `OpenClawKitTests/LocalLLM/DictationPolishTests.swift` — punctuation/capitalization fixes for 20 sample transcripts; named entities preserved.
- `OpenClawKitTests/LocalLLM/CapabilityTests.swift` — no-op stub returns sentinel values on unsupported simulators.
- macOS UI test: chat input "/" triggers local classifier before Gateway call.
- iOS UI test: Voice Wake transcript passes through `DictationPolish` before being submitted.

## Smoke checks

- On an Apple-Intelligence-capable Mac, toggle "Use on-device intelligence" off and on; behavior changes accordingly without restart.
- Run the apps offline (Wi-Fi off) and confirm intent classification still works while Gateway calls fail gracefully.

## Manual criteria

- Dictation polish reads as a clear improvement on a sample of 10 real Voice Wake transcripts (subjective — must not introduce hallucinations).
- Intent classifier doesn't misclassify a normal question as a `/command` (the most user-visible failure mode).

## AI eval plan

- Success criteria: intent classifier precision ≥ 0.95 and recall ≥ 0.90 for `chatCommand` class on a 100-input fixture; dictation polish WER reduction ≥ 30% vs. raw Whisper output on a 20-sample set.
- Eval dataset: `apps/shared/OpenClawKit/Sources/OpenClawKit/LocalLLM/Tests/Fixtures/`.
- Regression set: 8 inputs — `/status`, `/new`, "what's the weather", dictation with email + phone, dictation with proper nouns, ambiguous "summary please", noise/silence.
- Cadence: per-PR on the Apple test target; manual quarterly review on real recorded Voice Wake transcripts.

## Risks & rollback

- **Risks:**
  - Apple's framework changes the prompt API between OS versions. *Detect via* the CI Apple matrix (build against iOS 26 and the next-major beta).
  - On-device model hallucinates entities during dictation polish. *Mitigate* by clamping the polish prompt to "preserve named entities verbatim".
  - "Device intelligence" toggle ends up causing surprising offline gaps. *Mitigate* by defaulting to off when battery low / thermal pressure high.
- **Rollback:** flip the global "Use on-device intelligence" toggle off; the apps revert to Gateway-only behavior. App-level rollback if needed: ship a build that hides the toggle.

## Open questions

- Should we share the dictation polish output back to the Gateway alongside the raw transcript so the agent has both? Probably yes — costs nothing extra.
- Do we add a Liquid Glass-style indicator in macOS's status bar when an on-device call replaced a Gateway call? Defer to design.
