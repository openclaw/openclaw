# OpenRouter provider path Completeness

Use this rubric when assigning category Completeness scores for the
`openrouter-provider-path` surface.

## What Completeness Means Here

Completeness measures how fully OpenClaw exposes the intended `OpenRouter provider path` capability set to the user, operator, author, or maintainer persona for this surface. Score whether each category delivers the full expected workflow, including setup, normal use, status or inspection, recovery, and important platform/provider/channel variants where they apply.

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

- Provider Setup and Auth: First-run setup, Default model selection, Provider plugin registration, Model-ref examples, OPENROUTER_API_KEY, Auth profiles and auth order, Status/probe and removal, Provider-entry SecretRef/API-key resolution, Gateway env inheritance, Static catalog rows, Dynamic /models discovery, openrouter/auto and nested refs, Free-model scan/probe, Model list/picker cache
- Chat Runtime and Normalization: Chat completions route, Provider routing params, Per-model route overrides, Reasoning payload policy, Anthropic/Gemini/DeepSeek variants, Streamed content parsing, reasoning_details visible output, Tool-call delta preservation, Family-specific replay policy, Response-model and usage normalization, Attribution headers, Response-cache headers/TTL/clear, Anthropic cache-control markers, Cache usage mapping, Custom proxy exclusions
- Provider Recovery and Diagnostics: Timeout/retry classification, Auth/billing/key-limit classification, Context overflow, Model fallback notices, Guarded fetch/pricing warnings
- Media Generation and Speech: image_generate OpenRouter route, video_generate async jobs/polling/download, music_generate audio route, Text-to-speech, Speech-to-text transcription, Inbound media understanding, Generated artifact delivery

## Suggested Bands

- `Lovable` (95-100): complete across expected workflows, variants, and recovery branches, with only minor polish gaps.
- `Stable` (80-95): the expected workflow set is broadly present, with only bounded missing branches.
- `Beta` (70-80): the main workflow exists, but meaningful branches or recovery paths are still absent.
- `Alpha` (50-70): only a partial capability set is present; users can complete some core tasks but not the full expected workflow.
- `Experimental` (0-50): the category exposes only fragments of the intended capability.
