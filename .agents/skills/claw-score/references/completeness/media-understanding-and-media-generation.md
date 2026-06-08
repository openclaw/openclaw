# Media understanding and media generation Completeness

Use this rubric when assigning category Completeness scores for the
`media-understanding-and-media-generation` surface.

## What Completeness Means Here

Completeness measures how fully OpenClaw exposes the intended `Media understanding and media generation` capability set to the user, operator, author, or maintainer persona for this surface. Score whether each category delivers the full expected workflow, including setup, normal use, status or inspection, recovery, and important platform/provider/channel variants where they apply.

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

- Media Intake and Access: Local and remote media references, MIME and type detection, Size caps and bounded reads, Safe remote fetch, Local root policy, Inbound media store, PDF/document extraction dispatch, QR and media helper classification
- Channel Media Handling: Inbound attachment staging, Sandbox media rewrites, Reply media templating, Message-tool attachment delivery, Duplicate delivery suppression
- Media Configuration: Media capability configuration
- Text-to-Speech Delivery: TTS, Outbound Voice Audio Delivery
- Media Understanding: Audio attachment selection, Batch STT provider and CLI fallback, Voice-note mention preflight, Transcript insertion and echo, Audio proxy and limit handling, Inbound image summarization, Active vision model bypass, Text-only model media offload, Vision provider fallback, Image and PDF input routing, Video Understanding, Direct Video Analysis
- Media Generation: Image generation tool invocation, Provider and model selection, Reference image editing, Generated image task lifecycle, Generated image persistence and delivery, Music generation tool invocation, Provider and model selection, Lyrics, instrumental, duration, and format controls, Reference inputs where supported, Music task lifecycle and duplicate status, Generated audio persistence and delivery, Video generation tool invocation, Mode and provider capability selection, Reference image, video, and audio inputs, Provider option validation, Video task lifecycle and status, Generated video persistence and delivery

## Suggested Bands

- `Lovable` (95-100): complete across expected workflows, variants, and recovery branches, with only minor polish gaps.
- `Stable` (80-95): the expected workflow set is broadly present, with only bounded missing branches.
- `Beta` (70-80): the main workflow exists, but meaningful branches or recovery paths are still absent.
- `Alpha` (50-70): only a partial capability set is present; users can complete some core tasks but not the full expected workflow.
- `Experimental` (0-50): the category exposes only fragments of the intended capability.
