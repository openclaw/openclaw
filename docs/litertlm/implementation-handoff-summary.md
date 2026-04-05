# LiteRT-LM OpenClaw Implementation Handoff Summary

## What this project proved

This work established that Edge Gallery-downloaded `.litertlm` files can be used as real local models for OpenClaw — not by automating the Edge Gallery UI, but by loading those files directly with LiteRT-LM.

### Critical validated fact

- LiteRT-LM Python API on macOS successfully loaded the Edge Gallery-downloaded Gemma 4 E2B `.litertlm` model and returned correct local inference output.

### Also validated

- Gemma 4 E4B `.litertlm` also loads and answers successfully on CPU, though it is heavier and should remain optional experimental rather than default.

## Recommended architecture

```text
Edge Gallery
  -> local model downloader / manager

LiteRT-LM
  -> actual local inference runtime

OpenClaw
  -> experimental local provider / thin adapter
```

## What now exists in the workspace

### Runtime / wrapper prototypes

- `scripts/litertlm_model_resolver.py`
- `scripts/litertlm_runtime_resolver.py`
- `scripts/litertlm_local_chat.py`
- `scripts/litertlm_openclaw_wrapper.py`
- `scripts/litertlm_provider_shim.py`

### Key docs

- `docs/litertlm-openclaw-provider-design.md`
- `docs/litertlm-local-model-setup.md`
- `docs/litertlm-provider-shim-notes.md`
- `docs/litertlm-openclaw-experimental-adapter-spec.md`
- `docs/litertlm-openclaw-config-registration-draft.md`
- `docs/litertlm-openclaw-thin-adapter-skeleton.md`
- `docs/litertlm-openclaw-patch-plan.md`
- `docs/litertlm-openclaw-streamfn-contract-notes.md`
- `docs/litertlm-gemma4-e4b-practical-test-2026-04-04.md`
- `docs/litertlm-extension-compile-oriented-cleanup-plan.md`

### `openclaw-src` draft extension skeleton

- `openclaw-src/extensions/litertlm/index.ts`
- `openclaw-src/extensions/litertlm/src/provider-models.ts`
- `openclaw-src/extensions/litertlm/src/stream.ts`
- `openclaw-src/extensions/litertlm/index.test.ts`
- `openclaw-src/extensions/litertlm/README.md`

## Current technical recommendation

### Default experimental model

- `litertlm/gemma4-e2b-edge-gallery`

### Secondary optional experimental model

- `litertlm/gemma4-e4b-edge-gallery`

### Provider id

- `litertlm-local`

## Current provider strategy

Use a bundled provider plugin modeled loosely after Ollama, but with a major difference:

- **do not use HTTP transport to a local server**
- **do use a process-based shim over LiteRT-LM**

## Current stream strategy

For the first experimental version, do not block on token-level streaming.

Use a one-shot event strategy through `createAssistantMessageEventStream()`:

- `start`
- `text_start`
- one full `text_delta`
- `text_end`
- `done`
- `error`

## Important implementation constraints

### Keep

- process-based shim for first version
- CPU backend only
- E2B as default
- E4B as optional

### Avoid for now

- Edge Gallery UI integration
- pretending LiteRT-LM is OpenAI-compatible HTTP
- in-process runtime embedding on first pass
- token-streaming complexity on first pass

## Known repo-state caveat

`openclaw-src` already had unrelated changes / existing issues during this exploration, so the `extensions/litertlm/` draft was intentionally not wired into generated bundled entries and not treated as compile-ready.

This is a draft implementation package, not a merged provider patch.

## Best next implementation step

If continuing in `openclaw-src`, the next practical move is:

1. refine `extensions/litertlm/src/stream.ts` further as needed
2. decide shim-path strategy for real runtime usage
3. add provider registration tests
4. wire the extension into bundled plugin entries only after the above is stable

## Decision summary

This investigation is no longer blocked on architecture uncertainty.

The remaining work is standard implementation work:

- type alignment
- test alignment
- plugin wiring
- packaging/runtime path decisions

## Bottom line

**The strongest path is now clear:**

OpenClaw should treat LiteRT-LM as the local runtime and Edge Gallery as the source of locally downloaded `.litertlm` models.
