# Local model providers: Ollama, vLLM, SGLang, LM Studio Completeness

Use this rubric when assigning category Completeness scores for the
`local-model-providers-ollama-vllm-sglang-lm-studio` surface.

## What Completeness Means Here

Completeness measures how fully OpenClaw exposes the intended `Local model providers: Ollama, vLLM, SGLang, LM Studio` capability set to the user, operator, author, or maintainer persona for this surface. Score whether each category delivers the full expected workflow, including setup, normal use, status or inspection, recovery, and important platform/provider/channel variants where they apply.

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

- Provider Setup, Lifecycle, and Diagnostics: Provider Selection, Onboarding, localService configuration, Process startup and readiness, Request leases and idle shutdown, Health checks and restart, Provider recipes, Local provider status, Backend reachability probes, Model availability errors, Memory readiness diagnostics, Provider troubleshooting docs
- Native Provider Plugins: Ollama setup and model pulling, Model discovery, Streaming and vision, Ollama embeddings, Web-search support, LM Studio setup, Model discovery and auth, Model preload and JIT loading, Streaming compatibility, LM Studio embeddings
- OpenAI-Compatible Runtime Compatibility: Bundled provider setup, Model Discovery Endpoint, Non-interactive configuration, vLLM thinking controls, OpenAI-compatible chat and tool semantics, SGLang compatibility guidance, Request Stream Compatibility, Tool Calling
- Local Memory and Embeddings: Embedding provider selection, Memory search readiness, memoryFlush model override, Fallback lexical search, Provider mismatch guidance
- Network Safety and Prompt Controls: Safety Network, Prompt Pressure Controls

## Suggested Bands

- `Lovable` (95-100): complete across expected workflows, variants, and recovery branches, with only minor polish gaps.
- `Stable` (80-95): the expected workflow set is broadly present, with only bounded missing branches.
- `Beta` (70-80): the main workflow exists, but meaningful branches or recovery paths are still absent.
- `Alpha` (50-70): only a partial capability set is present; users can complete some core tasks but not the full expected workflow.
- `Experimental` (0-50): the category exposes only fragments of the intended capability.
