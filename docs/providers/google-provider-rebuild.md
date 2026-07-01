# Google provider rebuild boundary

This document captures the intended boundary for rebuilding OpenClaw's Google model integration.

## Problem

OpenClaw currently has more than one Google integration path:

- the supported Google AI Studio / Gemini API key provider
- the Google Vertex AI provider
- the Gemini CLI harness path
- legacy Gemini CLI OAuth setup code that can depend on Cloud Code Assist internals

The Gemini CLI path is useful for users who explicitly want a local CLI-backed runtime, but it is not a stable default provider boundary. It can depend on Google CLI behavior, local CLI config, and Cloud Code Assist project discovery. Those concerns should not be required for the official Google provider setup path.

## Rebuild target

The supported default Google model path should be API-backed and explicit:

- `google` means Google AI Studio / Gemini API key
- `google-vertex` means Vertex AI / ADC / service-account-backed Google Cloud auth
- `google-gemini-cli` means optional local Gemini CLI harness

Provider auth should not implicitly provision Google projects, scrape local CLI state, or require Cloud Code Assist internal endpoints.

## Current boundary change

The bundled Google runtime plugin now registers the Gemini CLI provider/backend only when this flag is explicitly enabled:

```bash
OPENCLAW_ENABLE_GOOGLE_GEMINI_CLI_HARNESS=1
```

Without that flag, bundled runtime registration stays on the official API-backed provider path and does not directly register the Gemini CLI harness. The setup-registry compatibility path remains available for existing `google-gemini-cli` setup/backend resolution.

## Follow-up work

A full rebuild should land as small follow-up PRs:

1. Remove Gemini CLI OAuth from default onboarding metadata or mark it manual-only behind the same opt-in boundary.
2. Add a first-class Gemini API provider implementation for the current official API surface.
3. Keep Vertex AI as a separate provider with its own auth and endpoint resolution.
4. Remove Cloud Code Assist project discovery from provider auth paths.
5. Add regression tests proving normal Google setup never calls `cloudcode-pa.googleapis.com`, `v1internal:loadCodeAssist`, or `v1internal:onboardUser`.
6. Keep Gemini CLI compatibility as an opt-in harness with direct warnings and no hidden onboarding side effects.
