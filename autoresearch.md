# Autoresearch: Bootstrap System Prompt Cache Optimisation

## Objective

Maximise Anthropic KV cache hit rate for the OpenClaw bootstrap system prompt pipeline.

**Metric:** `system_prompt_stable_chars` — characters in the system prompt before the first dynamic/variable content (timestamp, session ID, model). Higher is better. Larger stable prefix = more content eligible for KV caching.

**Secondary metric:** `system_prompt_total_chars` — total assembled system prompt length. Lower is better (cheaper tokens).

**Benchmark:** `./autoresearch.sh` — assembles the system prompt from the codebase, measures stable prefix size.

## Files in scope

- `src/agents/bootstrap-cache.ts` — session-keyed in-memory cache
- `src/agents/bootstrap-files.ts` — file loading + filter pipeline
- `src/agents/pi-embedded-helpers/bootstrap.ts` — `buildBootstrapContextFiles`, truncation logic
- `src/agents/workspace.ts` — workspace file discovery and loading

## Ideas to try (one at a time)

1. Move runtime block (timestamp, session ID, model) to after all stable workspace + skills content
2. Compress skills description injection: name + 50-char trigger summary only
3. Cross-session mtime-gated bootstrap cache (avoid re-reading unchanged files on new sessions)
4. Remove per-file object allocation in `trimBootstrapContent` for non-truncated files (return original string reference)
5. Skills list hash-gated regeneration: only rebuild skills section when hash changes

## Results

| Run | Change | stable_chars | total_chars | status |
| --- | ------ | ------------ | ----------- | ------ |

## Dead ends

(none yet)

## Key wins

(none yet)
