---
summary: "Deepgram, BytePlus, ComfyUI, and the shared image/music/video generation live sweeps"
title: "Media provider live lanes"
read_when:
  - You are running an image, music, or video generation live sweep
  - You changed a media provider plugin and need its live lane
---

## Deepgram live (audio transcription)

- Test: `extensions/deepgram/audio.live.test.ts`
- Enable: `DEEPGRAM_API_KEY=... DEEPGRAM_LIVE_TEST=1 pnpm test:live extensions/deepgram/audio.live.test.ts`

## BytePlus coding plan live

- Test: `extensions/byteplus/live.test.ts`
- Enable: `BYTEPLUS_API_KEY=... BYTEPLUS_LIVE_TEST=1 pnpm test:live extensions/byteplus/live.test.ts`
- Optional model override: `BYTEPLUS_CODING_MODEL=ark-code-latest`

## ComfyUI workflow media live

- Test: `extensions/comfy/comfy.live.test.ts`
- Enable: `OPENCLAW_LIVE_TEST=1 COMFY_LIVE_TEST=1 pnpm test:live -- extensions/comfy/comfy.live.test.ts`
- Scope:
  - Exercises the comfy image, video, and `music_generate` paths
  - Skips each capability unless `plugins.entries.comfy.config.<capability>` is configured
  - Useful after changing comfy workflow submission, polling, downloads, or plugin registration

## Image generation live

- Test: `test/image-generation.runtime.live.test.ts`
- Command: `pnpm test:live test/image-generation.runtime.live.test.ts`
- Harness: `pnpm test:live:media image`
- Scope:
  - Enumerates every registered image-generation provider plugin
  - Uses already-exported provider env vars before probing
  - Uses live/env API keys ahead of stored auth profiles by default, so stale test keys in SQLite auth stores do not mask real shell credentials
  - Skips providers with no usable auth/profile/model
  - Runs each configured provider through the shared image-generation runtime:
    - `<provider>:generate`
    - `<provider>:edit` when the provider declares edit support
- Current bundled providers covered:
  - `deepinfra`
  - `fal`
  - `google`
  - `minimax`
  - `openai`
  - `openrouter`
  - `vydra`
  - `xai`
- Optional narrowing:
  - `OPENCLAW_LIVE_IMAGE_GENERATION_PROVIDERS="openai,google,openrouter,xai"`
  - `OPENCLAW_LIVE_IMAGE_GENERATION_PROVIDERS="deepinfra"`
  - `OPENCLAW_LIVE_IMAGE_GENERATION_MODELS="openai/gpt-image-2,google/gemini-3.1-flash-image,openrouter/google/gemini-3.1-flash-image-preview,xai/grok-imagine-image"`
  - `OPENCLAW_LIVE_IMAGE_GENERATION_CASES="google:flash-generate,google:pro-edit,openrouter:generate,xai:default-generate,xai:default-edit"`
- Optional auth behavior:
  - `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` to force profile-store auth and ignore env-only overrides

For the shipped CLI path, add an `infer` smoke after the provider/runtime live
test passes:

```bash
OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_INFER_CLI_TEST=1 pnpm test:live -- test/image-generation.infer-cli.live.test.ts
openclaw infer image providers --json
openclaw infer image generate \
  --model google/gemini-3.1-flash-image \
  --prompt "Minimal flat test image: one blue square on a white background, no text." \
  --output ./openclaw-infer-image-smoke.png \
  --json
```

This covers CLI argument parsing, config/default-agent resolution, bundled
plugin activation, the shared image-generation runtime, and the live provider
request. Plugin dependencies are expected to be present before runtime load.

## Music generation live

- Test: `extensions/music-generation-providers.live.test.ts`
- Enable: `OPENCLAW_LIVE_TEST=1 pnpm test:live -- extensions/music-generation-providers.live.test.ts`
- Harness: `pnpm test:live:media music`
- Scope:
  - Exercises the shared bundled music-generation provider path
  - Currently covers `fal`, `google`, `minimax`, and `openrouter`
  - Uses already-exported provider env vars before probing
  - Uses live/env API keys ahead of stored auth profiles by default, so stale test keys in SQLite auth stores do not mask real shell credentials
  - Skips providers with no usable auth/profile/model
  - Runs both declared runtime modes when available:
    - `generate` with prompt-only input
    - `edit` when the provider declares `capabilities.edit.enabled`
  - `comfy` has its own separate live file, not this shared sweep
- Optional narrowing:
  - `OPENCLAW_LIVE_MUSIC_GENERATION_PROVIDERS="google,minimax"`
  - `OPENCLAW_LIVE_MUSIC_GENERATION_MODELS="google/lyria-3-clip-preview,minimax/music-2.6"`
- Optional auth behavior:
  - `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` to force profile-store auth and ignore env-only overrides

## Video generation live

- Test: `extensions/video-generation-providers.live.test.ts`
- Enable: `OPENCLAW_LIVE_TEST=1 pnpm test:live -- extensions/video-generation-providers.live.test.ts`
- Harness: `pnpm test:live:media video`
- Scope:
  - Exercises the shared bundled video-generation provider path across `alibaba`, `byteplus`, `deepinfra`, `fal`, `google`, `minimax`, `openai`, `openrouter`, `pixverse`, `qwen`, `runway`, `together`, `vydra`, `xai`
  - Defaults to the release-safe smoke path: one text-to-video request per provider, one-second lobster prompt, and a per-provider operation cap from `OPENCLAW_LIVE_VIDEO_GENERATION_TIMEOUT_MS` (`180000` by default)
  - Skips FAL by default because provider-side queue latency can dominate release time; pass `OPENCLAW_LIVE_VIDEO_GENERATION_PROVIDERS="fal"` (or clear the skip list) to run it explicitly
  - Uses already-exported provider env vars before probing
  - Uses live/env API keys ahead of stored auth profiles by default, so stale test keys in SQLite auth stores do not mask real shell credentials
  - Skips providers with no usable auth/profile/model
  - Runs only `generate` by default
  - Set `OPENCLAW_LIVE_VIDEO_GENERATION_FULL_MODES=1` to also run declared transform modes when available:
    - `imageToVideo` when the provider declares `capabilities.imageToVideo.enabled` and the selected provider/model accepts buffer-backed local image input in the shared sweep
    - `videoToVideo` when the provider declares `capabilities.videoToVideo.enabled` and the selected provider/model accepts buffer-backed local video input in the shared sweep
  - Current declared-but-skipped `imageToVideo` provider in the shared sweep:
    - `vydra` (buffer-backed local image input is not supported in this lane)
  - Provider-specific Vydra coverage:
    - `OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_VYDRA_VIDEO=1 pnpm test:live -- extensions/vydra/vydra.live.test.ts`
    - That file runs `veo3` text-to-video plus a `kling` image-to-video lane that uses a remote image URL fixture by default (`OPENCLAW_LIVE_VYDRA_KLING_IMAGE_URL` to override).
  - Provider-specific xAI coverage:
    - `OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_XAI_VIDEO=1 pnpm test:live -- extensions/xai/xai.live.test.ts -t "classic Grok Imagine"`
    - The classic case generates a square local PNG first frame, omits geometry, requests a one-second image-to-video clip, polls to completion, and verifies the downloaded buffer.
    - `OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_XAI_VIDEO=1 pnpm test:live -- extensions/xai/xai.live.test.ts -t "Grok Imagine Video 1.5"`
    - The 1.5 case generates a local PNG first frame, requests a one-second 1080P image-to-video clip, polls to completion, and verifies the downloaded buffer.
  - Current `videoToVideo` live coverage:
    - `runway` only when the selected model resolves to `gen4_aleph`
  - Current declared-but-skipped `videoToVideo` providers in the shared sweep:
    - `alibaba`, `google`, `openai`, `qwen`, `xai` because those paths currently require remote `http(s)` reference URLs rather than buffer-backed local input
- Optional narrowing:
  - `OPENCLAW_LIVE_VIDEO_GENERATION_PROVIDERS="deepinfra,google,openai,runway"`
  - `OPENCLAW_LIVE_VIDEO_GENERATION_MODELS="google/veo-3.1-fast-generate-preview,openai/sora-2,runway/gen4_aleph"`
  - `OPENCLAW_LIVE_VIDEO_GENERATION_SKIP_PROVIDERS=""` to include every provider in the default sweep, including FAL
  - `OPENCLAW_LIVE_VIDEO_GENERATION_TIMEOUT_MS=60000` to reduce each provider operation cap for an aggressive smoke run
- Optional auth behavior:
  - `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` to force profile-store auth and ignore env-only overrides

## Media live harness

- Command: `pnpm test:live:media`
- Entrypoint: `test/e2e/qa-lab/media/hosted-media-provider-live.ts`, which runs `pnpm test:live -- <suite-test-file>` per selected suite, so heartbeat and quiet-mode behavior stay consistent with other `pnpm test:live` runs.
- Purpose:
  - Runs the shared image, music, and video live suites through one repo-native entrypoint
  - Auto-loads missing provider env vars from `~/.profile`
  - Auto-narrows each suite to providers that currently have usable auth by default
- Flags:
  - `--providers <csv>` global provider filter; `--image-providers` / `--music-providers` / `--video-providers` scope a filter to one suite
  - `--all-providers` skips the auth-based auto-filter
  - `--allow-empty` exits `0` when filtering leaves no runnable providers
  - `--quiet` / `--no-quiet` passed through to `test:live`
- Examples:
  - `pnpm test:live:media`
  - `pnpm test:live:media image video --providers openai,google,minimax`
  - `pnpm test:live:media video --video-providers openai,runway --all-providers`
  - `pnpm test:live:media music --quiet`
