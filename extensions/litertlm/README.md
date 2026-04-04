# LiteRT-LM Provider Skeleton

Experimental bundled-provider skeleton for using Edge Gallery-downloaded `.litertlm` files through LiteRT-LM.

## Status

Draft only.
Not wired into generated bundled plugin entries.
Not guaranteed to compile yet.

## Intent

Provide the smallest plausible `openclaw-src/extensions/litertlm/` shape so future implementation work is no longer blocked on architecture uncertainty.

## Files

- `index.ts`
- `src/provider-models.ts`
- `src/stream.ts`

## Current assumptions

- provider id: `litertlm-local`
- first experimental model: `litertlm/gemma4-e2b-edge-gallery`
- optional second model: `litertlm/gemma4-e4b-edge-gallery`
- process-based shim remains the runtime bridge
