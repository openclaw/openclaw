# Plan

Add Gemini 3.1 Flash TTS as a Google speech provider in OpenClaw by extending the existing bundled Google plugin, keeping provider-specific behavior out of core runtime. The first implementation should use the Gemini API key path already owned by `extensions/google`, return WAV audio from Gemini's 24 kHz PCM output, and pass Gemini audio tags through inside the existing `[[tts:text]]...[[/tts:text]]` flow.

Tracking issue: https://github.com/openclaw/openclaw/issues/67458, "[Feature] Gemini 3.1 Flash TTS support in messages.tts, with expressive tag passthrough".

## Scope

- In:
  - Add a `google` speech provider under `extensions/google`.
  - Support Gemini API `generateContent` TTS with `gemini-3.1-flash-tts-preview`.
  - Support `messages.tts.provider: "google"` and `messages.tts.providers.google`.
  - Support `GEMINI_API_KEY` and `GOOGLE_API_KEY` fallback.
  - Use the existing `google` provider id; do not introduce a separate canonical `gemini` speech provider id in phase 1.
  - Preserve Gemini square-bracket audio tags such as `[whispers]`, `[laughs]`, `[sighs]`, and `[excited]`.
  - Support normal audio attachment delivery by returning WAV audio.
  - Add provider tests, registration contract updates, docs, and PR validation notes.
- Out:
  - Do not add Google-specific branches to `extensions/speech-core` or core `src/tts`.
  - Do not add Cloud Text-to-Speech, Vertex AI auth, or Google auth-profile reuse in phase 1.
  - Do not implement multi-speaker dialogue in phase 1 unless the provider contract is extended.
  - Do not promise native voice-note compatibility until the provider can emit or transcode Opus.

## Findings

### PR criteria

- OpenClaw expects feature work to be focused and, for larger/new features, to start from a GitHub issue or Discord discussion before PR.
- Baseline documented local gates are `pnpm build && pnpm check && pnpm test`.
- For extension/provider work, start with `pnpm test:extension google`; run plugin contracts if speech provider registration metadata changes.
- PR text must explain the problem, why it matters, changed scope, user-visible behavior, security impact, verification evidence, and migration/compatibility risks.
- This PR must mark security impact as yes because it adds a new network call path and TTS API-key handling under `messages.tts.providers.google.apiKey`.
- AI-assisted work should disclose AI assistance and testing level, and bot/review conversations must be resolved before merge.
- Issue `#67458` exists for this feature, so the PR should link it with `Closes #67458` if the phase 1 scope satisfies the requested `messages.tts` provider and tag-passthrough behavior.

### OpenClaw TTS architecture

- TTS is plugin-backed through `SpeechProviderPlugin` in `src/plugins/types.ts`.
- Provider registration is discovered from plugin runtime registration and manifest `contracts.speechProviders`.
- Runtime selection, fallback, directives, temp-file creation, and telephony synthesis live in `extensions/speech-core/src/tts.ts`.
- Provider-specific implementation belongs in the provider plugin. Existing examples are `extensions/openai/speech-provider.ts`, `extensions/elevenlabs/speech-provider.ts`, `extensions/microsoft/speech-provider.ts`, and `extensions/minimax/speech-provider.ts`.
- `extensions/google` already owns Gemini API key auth, Google model normalization, Gemini API HTTP helper configuration, image generation, media understanding, music/video generation, and web search.
- The clean integration point is `extensions/google/speech-provider.ts`, registered from `extensions/google/index.ts`.
- `SpeechSynthesisResult` must return `audioBuffer`, `outputFormat`, `fileExtension`, and `voiceCompatible`.
- `SpeechTelephonySynthesisResult` can return raw PCM and a sample rate; Gemini API TTS already returns PCM, so phase 1 can support Talk/telephony without adding an encoder.
- Phase 1 should stay API-key only because `SpeechSynthesisRequest` does not currently carry `agentDir` or an auth-profile store, and changing that would expand the blast radius beyond this issue.

### Gemini TTS docs

- Official Google Gemini docs list Gemini 3.1 Flash TTS Preview as `gemini-3.1-flash-tts-preview`: https://ai.google.dev/gemini-api/docs/speech-generation
- Google Cloud Gemini-TTS docs also list `gemini-3.1-flash-tts-preview` and describe API choice tradeoffs: https://docs.cloud.google.com/text-to-speech/docs/gemini-tts
- Gemini API TTS uses `generateContent` with `generationConfig.responseModalities: ["AUDIO"]` and `generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName`.
- Gemini API and Vertex examples return inline base64 PCM audio, 16-bit mono at 24 kHz, without a WAV header. OpenClaw should wrap this PCM into WAV for normal audio attachment delivery.
- Cloud Text-to-Speech can produce formats such as `LINEAR16`, `MULAW`, `MP3`, `OGG_OPUS`, and `PCM`, but it requires the Cloud TTS API/project/IAM flow and is better as a later provider mode.
- Gemini supports 30 prebuilt voices, including `Kore`, `Puck`, `Zephyr`, `Charon`, `Fenrir`, `Leda`, `Aoede`, and `Callirrhoe`.
- Gemini supports single-speaker and up to two-speaker TTS, but the current OpenClaw TTS request contract is a single text request plus provider overrides, so single-speaker is the practical first step.
- Gemini audio tags are ordinary square-bracket words embedded in the transcript. The docs state there is no exhaustive supported list and recommend English tags even for non-English transcripts.
- Useful tags to document for users include `[whispers]`, `[sighs]`, `[laughs]`, `[gasp]`, `[excited]`, `[shouting]`, `[sarcastic]`, `[serious]`, `[tired]`, and `[trembling]`.
- Gemini 3.1 Flash TTS Preview limitations to handle: no streaming in the Gemini API TTS path, occasional text-token or server failures, and prompt rejection or accidental instruction read-aloud when prompts are vague.

## Decisions

- Auth: phase 1 uses only API-key surfaces: `messages.tts.providers.google.apiKey`, `models.providers.google.apiKey`, `GEMINI_API_KEY`, or `GOOGLE_API_KEY`.
- Provider id: phase 1 registers speech under the existing `google` provider id.
- Native voice-note compatibility: phase 1 returns WAV audio attachment output and sets `voiceCompatible: false`; native voice-note output should be a follow-up via a shared PCM-to-Opus path, provider-local ffmpeg transcode, or a Cloud Text-to-Speech mode that can return `OGG_OPUS`.

## Action items

[x] Link the implementation plan to issue `#67458`; no separate tracking issue is needed for the initial PR.

[x] Add `extensions/google/speech-provider.ts` with `buildGoogleSpeechProvider(): SpeechProviderPlugin`, defaults `model: "gemini-3.1-flash-tts-preview"`, `voiceName: "Kore"`, static Gemini voice list, provider config normalization, directive parsing, `listVoices`, `isConfigured`, `synthesize`, and `synthesizeTelephony`.

[x] Reuse Google plugin HTTP/auth helpers where possible: `resolveGoogleGenerativeAiHttpRequestConfig`, `parseGeminiAuth`, `postJsonRequest`, and `assertOkOrThrowHttpError`; add only provider-local PCM-to-WAV and response parsing helpers.

[x] Implement Gemini request construction and pass `req.text` unchanged so Google audio tags survive. Example behavior: `[[tts:text]][whispers] I have an idea.[[/tts:text]]` sends `[whispers] I have an idea.` to Gemini.

[x] Decode `candidates[].content.parts[].inlineData.data`, validate the response contains audio data, wrap 24 kHz signed 16-bit little-endian mono PCM into an in-memory WAV buffer, and return `outputFormat: "wav"`, `fileExtension: ".wav"`, `voiceCompatible: false`.

[ ] Consider bounded retry behavior later if real Gemini TTS failures show a repeatable transient pattern; keep phase 1 aligned with the existing Google image-generation error path.

[x] Register the speech provider in `extensions/google/index.ts`, add `"speechProviders": ["google"]` to `extensions/google/openclaw.plugin.json`, and update `extensions/google/plugin-registration.contract.test.ts` plus shared contract cases.

[x] Add focused tests in `extensions/google/speech-provider.test.ts` for env fallback, directive parsing, voice listing, request payload shape, audio-tag passthrough, PCM-to-WAV wrapping, and telephony PCM.

[x] Add or update documentation in `docs/tools/tts.md` and `docs/providers/google.md`, including config examples, env vars, supported model/voice defaults, WAV output note, Cloud-vs-Gemini API key clarification, and Gemini audio-tag guidance.

[x] Validate locally with targeted commands first: `pnpm test:extension google`, plugin contracts, and focused linting. Full `pnpm tsgo` currently fails on pre-existing Telegram `AbortSignal` type mismatches, so `pnpm build`, `pnpm check`, and full `pnpm test` remain PR pre-merge gates.

## Proposed config

```json5
{
  messages: {
    tts: {
      auto: "tagged",
      provider: "google",
      providers: {
        google: {
          apiKey: "${GEMINI_API_KEY}",
          model: "gemini-3.1-flash-tts-preview",
          voiceName: "Kore",
        },
      },
    },
  },
}
```

## Audio tag usage

```text
[[tts:text]]
[whispers] This is the quiet part.
[laughs] Now we can say it normally.
[[/tts:text]]
```

The implementation should not strip, translate, or reinterpret the single-bracket Gemini tags. OpenClaw's double-bracket `[[tts:...]]` directives remain the OpenClaw control surface; Gemini's single-bracket tags are transcript content passed through to the provider.

## Validation commands

```bash
pnpm test:extension google
node scripts/run-vitest.mjs run --config test/vitest/vitest.extension-providers.config.ts extensions/google/speech-provider.test.ts extensions/google/plugin-registration.contract.test.ts
pnpm test:contracts:plugins
pnpm build
pnpm check
pnpm test
```

## Follow-up questions

- Should native voice-note support be implemented later through a shared PCM-to-Opus path, a provider-local ffmpeg transcode, or a Cloud Text-to-Speech mode with `OGG_OPUS` output?
- Should multi-speaker Gemini TTS become a later provider-specific directive/config extension after single-speaker support lands?
