# LiteRT-LM OpenClaw StreamFn Contract Notes

## Purpose

Capture the minimum code-level understanding needed before implementing a real `litertlm` provider plugin in `openclaw-src`.

## Key findings

### 1. Best reference provider is still Ollama

Most relevant implementation:

- `openclaw-src/extensions/ollama/src/stream.ts`

Why:

- it implements `createStreamFn(...)`
- it owns a custom transport path
- it constructs an assistant-message event stream directly

### 2. `createStreamFn(...)` returns a `StreamFn`

Observed usage in:

- `openclaw-src/src/agents/provider-stream.ts`

OpenClaw flow:

- resolve provider plugin stream function
- register custom API transport via `ensureCustomApiRegistered(...)`
- let the embedded runner use that stream function for the selected model

### 3. Practical StreamFn shape from Ollama example

The custom stream function returns a stream created by:

- `createAssistantMessageEventStream()` from `@mariozechner/pi-ai`

Then it pushes events like:

- `start`
- `text_start`
- `text_delta`
- `text_end`
- `done`
- `error`

### 4. For a first LiteRT-LM version, full token streaming is not required conceptually

The first realistic approach can be:

- create assistant-message event stream
- run the shim in background async task
- when full text is available, emit:
  - `start`
  - `text_start`
  - one `text_delta` containing the whole text
  - `text_end`
  - `done`
- on failure emit `error`

This is not ideal streaming UX, but it is enough for a first experimental provider path if the event shape is respected.

## Implication for LiteRT-LM provider design

### Minimal provider structure now looks plausible

```text
openclaw-src/extensions/litertlm/
  index.ts
  src/
    provider-models.ts
    stream.ts
```

### `index.ts`

Should:

- register provider id such as `litertlm-local`
- publish discovery/catalog entry for `litertlm/gemma4-e2b-edge-gallery`
- use synthetic auth
- attach `createStreamFn(...)`

### `src/stream.ts`

Should:

- import `createAssistantMessageEventStream`
- shell out to `scripts/litertlm_provider_shim.py`
- parse normalized JSON
- emit assistant-message events

### `src/provider-models.ts`

Should:

- define initial model rows
- keep E2B as default experimental row
- optionally add E4B as secondary experimental row later

## Suggested first event strategy for LiteRT-LM

### Success path

1. create event stream
2. start async shim run
3. when shim returns success:
   - emit `start`
   - emit `text_start`
   - emit one `text_delta` with `output_text`
   - emit `text_end`
   - emit `done`

### Error path

- emit `error` with a synthesized assistant error message

## Why this matters

This reduces the remaining unknown significantly.

The LiteRT-LM provider no longer looks blocked on hidden core abstractions. It mainly needs:

- a provider plugin entry
- a shim-backed stream emitter
- a small model catalog definition
