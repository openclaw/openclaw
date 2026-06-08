# Image/video/music generation tools Completeness

Use this rubric when assigning category Completeness scores for the
`image-video-music-generation-tools` surface.

## What Completeness Means Here

Completeness measures how fully OpenClaw exposes the intended `Image/video/music generation tools` capability set to the user, operator, author, or maintainer persona for this surface. Score whether each category delivers the full expected workflow, including setup, normal use, status or inspection, recovery, and important platform/provider/channel variants where they apply.

## Scoring Questions

For each category, ask:

- Can the intended user or operator complete the category workflow end to end?
- Are the taxonomy features present as supported capabilities rather than isolated implementation fragments?
- Are the important lifecycle stages represented: setup, normal operation, status/inspection, recovery, and upgrade or removal where relevant?
- Are the important environment, provider, platform, channel, or security branches present for this surface?
- Do the known gaps leave major user-visible capability branches missing?

## Surface-Specific Guidance

- Favor higher Completeness when the category supports the full operator-visible workflow described by taxonomy and the category note evidence.
- Lower Completeness when only the happy path exists, when important variants are undocumented or unimplemented, or when recovery/status paths are missing.
- Do not lower Completeness because tests are thin; that is Coverage.
- Do not lower Completeness because implementation quality is fragile; that is Quality.

## Category Scope

- Media Routing and Discovery: default media model config, per-call model refs and fallbacks, auth-backed tool discovery, action=list provider inspection
- Task Lifecycle and Delivery: background task creation, task status/list/show/cancel, duplicate guards, progress keepalive, completion/failure wake, no-session inline fallback, local media persistence, MIME/filename inference, Hosted URL fallback, message-tool handoff, idempotent missing-media fallback, channel attachment proof
- Image Generation: text-to-image, reference-image editing, output hints, action=status, provider attempt metadata, OpenAI/Codex OAuth, API-key OpenAI, OpenRouter/xAI/fal/LiteLLM/DeepInfra/Google/MiniMax/ComfyUI auth, provider error diagnostics
- Video Generation: text-to-video, image-to-video, video-to-video, reference role validation, audio refs, typed providerOptions, queue-backed jobs, polling/timeout handling, Hosted URL download, provider skip explanations, returned asset metadata
- Music Generation: prompt and lyrics input, instrumental mode, duration/format controls, image-reference edit lanes, generated audio outputs, provider fallback

## Suggested Bands

- `Lovable` (95-100): complete across expected workflows, variants, and recovery branches, with only minor polish gaps.
- `Stable` (80-95): the expected workflow set is broadly present, with only bounded missing branches.
- `Beta` (70-80): the main workflow exists, but meaningful branches or recovery paths are still absent.
- `Alpha` (50-70): only a partial capability set is present; users can complete some core tasks but not the full expected workflow.
- `Experimental` (0-50): the category exposes only fragments of the intended capability.
