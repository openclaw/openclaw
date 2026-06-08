# Voice and realtime talk Completeness

Use this rubric when assigning category Completeness scores for the
`voice-and-realtime-talk` surface.

## What Completeness Means Here

Completeness measures how fully OpenClaw exposes the intended `Voice and realtime talk` capability set to the user, operator, author, or maintainer persona for this surface. Score whether each category delivers the full expected workflow, including setup, normal use, status or inspection, recovery, and important platform/provider/channel variants where they apply.

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

- Talk Providers: OpenAI Realtime voice backend bridge, Google Gemini Live backend bridge, Realtime voice provider SDK contracts, Provider diagnostics, Talk catalog, Talk provider config, Shared native config parsing
- Realtime Talk Sessions: Agent consult handoff, Active Talk agent-run status, Talkback runtime behavior, Forced consult scheduling, Browser Talk start/stop UI, Browser WebRTC sessions, Browser relay mode, Browser tool-call forwarding, Realtime session controls, Gateway relay sessions, Audio-frame limits
- Speech and Transcription: Voice directives, Talk speech playback, Transcription relay sessions, Realtime transcription providers, Native directive parsing
- Native App Talk: macOS native Talk mode, iOS Talk mode, Android Talk mode, Shared Talk config
- Voice Wake and Routing: Wake-word settings, Wake routing, macOS Voice Wake runtime, Mobile wake preferences
- Talk Observability: Talk event logging, Session-log health, Live smoke output, Prometheus diagnostic counters, Operator visibility into setup

## Suggested Bands

- `Lovable` (95-100): complete across expected workflows, variants, and recovery branches, with only minor polish gaps.
- `Stable` (80-95): the expected workflow set is broadly present, with only bounded missing branches.
- `Beta` (70-80): the main workflow exists, but meaningful branches or recovery paths are still absent.
- `Alpha` (50-70): only a partial capability set is present; users can complete some core tasks but not the full expected workflow.
- `Experimental` (0-50): the category exposes only fragments of the intended capability.
