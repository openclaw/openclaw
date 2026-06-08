# Google provider path Completeness

Use this rubric when assigning category Completeness scores for the
`google-provider-path` surface.

## What Completeness Means Here

Completeness measures how fully OpenClaw exposes the intended `Google provider path` capability set to the user, operator, author, or maintainer persona for this surface. Score whether each category delivers the full expected workflow, including setup, normal use, status or inspection, recovery, and important platform/provider/channel variants where they apply.

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

- Provider Setup and Credentials: API key onboarding, Auth choice metadata, Gemini CLI OAuth setup, Vertex ADC setup, Daemon and fallback credentials, CLI runtime selection, OAuth login and refresh, Canonical Google model refs, CLI usage normalization, OAuth diagnostics
- Model Routing and Endpoints: Catalog rows and aliases, Dynamic model resolution, Provider routing, Google-native config normalization, Model picker availability, Vertex provider selection, ADC/service-account auth, Project/location endpoints, Custom base URL policy, Compatibility boundaries
- Direct Gemini Runtime: Direct Gemini chat, Multimodal inputs, Tool-call streaming, Usage and stop reasons, Thought-signature replay, Thinking-level mapping, Thought-signature replay, Tool turn ordering, Incomplete-turn recovery, Planning-only turn recovery
- Media, Search, and Realtime: Bundled plugin distribution, Provider auto-enable metadata, Image and media adapters, Speech and realtime adapters, Search and generation tools, Realtime voice sessions, Constrained browser tokens, Audio and transcript events, Live tool calls, Session reconnects
- Prompt Caching: Cache retention config, Managed cachedContents, Manual cachedContent handles, Cache usage accounting, Cache diagnostics and live proof

## Suggested Bands

- `Lovable` (95-100): complete across expected workflows, variants, and recovery branches, with only minor polish gaps.
- `Stable` (80-95): the expected workflow set is broadly present, with only bounded missing branches.
- `Beta` (70-80): the main workflow exists, but meaningful branches or recovery paths are still absent.
- `Alpha` (50-70): only a partial capability set is present; users can complete some core tasks but not the full expected workflow.
- `Experimental` (0-50): the category exposes only fragments of the intended capability.
