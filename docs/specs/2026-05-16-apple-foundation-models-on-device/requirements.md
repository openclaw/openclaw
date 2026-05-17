# Requirements — Apple Foundation Models on-device bridge

## Outcome

On iOS 26 / macOS Tahoe 26 / Apple Intelligence-capable devices, the openclaw apps use Apple's on-device ~3B foundation model for cheap local inference: intent classification ("is this a chat command or a question?"), wake-phrase candidate filtering, post-Whisper dictation polish, and short summaries — keeping these out of the Anthropic + OpenAI bills and off the network entirely. The Gateway and core text-agent path remain unchanged.

## Users affected

- iOS / macOS app users on Apple Intelligence-capable hardware.
- The Talk Mode / Voice Wake stack — pre-agent polish.
- The chat UI — local "did you mean" suggestions, message classification.
- App code: `apps/macos/Sources/`, `apps/ios/Sources/`, `apps/shared/OpenClawKit/Sources/`.

## In scope

- New `OpenClawLocalLLM` module in `apps/shared/OpenClawKit/Sources/` wrapping Apple's Foundation Models framework (Swift, iOS 18+ / macOS 15+ — Apple Intelligence required).
- Intent classifier: short prompts in / typed `Intent` enum out (`chatCommand`, `question`, `dictationFragment`, `noise`).
- Dictation polish: post-Whisper STT pass that fixes punctuation/capitalization locally before submitting to the agent.
- Local summarization for very short transcripts (≤ N tokens) when an operator opts in.
- Hard fallback to "do nothing locally, send everything to the Gateway" on unsupported devices.

## Out of scope

- Replacing or supplementing the Gateway's text-agent path — Apple's 3B model is not the assistant brain.
- Android equivalent (Gemini Nano / on-device Gemini) — separate spec; the Android app currently uses Apple cloud / Gateway path.
- Cross-vendor inference abstraction — keep this Apple-specific to ship cleanly.
- Storing prompts/responses from the on-device model in transcripts — local-only, ephemeral.

## Decisions

- Use Apple's Foundation Models framework directly, not via a wrapper library. Reason: framework is GA on iOS 26 / macOS Tahoe 26 and stable; wrappers add lag.
- Intent classifier output is an enum, not free-text. Reason: easier to test, easier to wire into the existing voice/chat dispatch.
- Local results never claim to be from the assistant — UI labels them as "device" or hides them entirely. Reason: prevents operator confusion about which model produced an answer.
- Opt-out, not opt-in, on capable devices. Reason: cost + privacy win is high; risk of degrading UX is low if the fallback is clean.
