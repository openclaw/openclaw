# LiteRT-LM `stream.ts` Refactor Outline

## Goal

Move `extensions/litertlm/src/stream.ts` from a local-machine prototype into a merge-friendly experimental shim adapter.

## Current problems

- hardcoded `python3`
- hardcoded repo-root shim path
- ad hoc request payload
- loose response parsing
- no explicit config resolution layer
- no clean separation between request building, shim invocation, and response mapping

## Target structure

## 1. `resolveLiteRtLmRuntimeConfig()`

Source: `extensions/litertlm/src/runtime-config.ts`

Responsibility:
- read provider config
- read env fallback
- resolve:
  - `pythonPath`
  - `shimPath`
  - `modelFile`
  - `timeoutMs`
  - `backend`

Should not:
- run subprocesses
- parse model output

## 2. `buildLiteRtLmShimRequest()`

Source: `extensions/litertlm/src/runtime-config.ts`

Responsibility:
- normalize prompt/system/messages into a versioned request
- attach model metadata
- attach runtime metadata
- attach generation options

Output:
- `LiteRtLmShimRequest`

## 3. `invokeLiteRtLmShim()`

Recommended new helper in `stream.ts` or a small helper file.

Responsibility:
- call `execFile`
- pass JSON request over stdin (preferred) or structured CLI arg fallback
- apply timeout
- capture stdout/stderr
- parse JSON response
- map non-zero exit / malformed JSON to explicit runtime errors

Suggested signature:

```ts
async function invokeLiteRtLmShim(params: {
  runtimeConfig: LiteRtLmRuntimeConfig;
  request: LiteRtLmShimRequest;
}): Promise<LiteRtLmShimResponse>
```

## 4. `mapLiteRtLmShimResponseToAssistantOutput()`

Responsibility:
- convert shim success output into OpenClaw assistant output shape
- convert shim failure into actionable provider errors

Should handle:
- missing/invalid response shape
- `ok: false` structured errors
- optional usage/diagnostics passthrough

## 5. top-level `stream.ts` flow

Suggested high-level flow:

```ts
const runtimeConfig = resolveLiteRtLmRuntimeConfig({ ... });

if (!runtimeConfig.modelFile) {
  throw new Error("litertlm provider requires a configured modelFile");
}

const request = buildLiteRtLmShimRequest({ ... });
const response = await invokeLiteRtLmShim({ runtimeConfig, request });
return mapLiteRtLmShimResponseToAssistantOutput(response);
```

## Minimal error mapping policy

### Configuration errors
- missing model file
- invalid shim path
- invalid provider config

### Environment errors
- python executable not found
- shim import failure
- LiteRT-LM runtime missing

### Runtime errors
- model load failure
- inference failure
- timeout
- malformed shim response

## Suggested file layout

- `extensions/litertlm/src/runtime-config.ts`
- `extensions/litertlm/src/stream.ts`
- optional later split:
  - `extensions/litertlm/src/shim-invoke.ts`
  - `extensions/litertlm/src/error-map.ts`

## Merge-friendly first pass

For the first mergeable pass, it is enough to:
- add `runtime-config.ts`
- update `stream.ts` to use config/env-based resolution
- switch to versioned request/response types
- improve timeout + error mapping
- keep one-shot text generation only

## Explicit non-goals for this refactor

- token streaming
- multi-turn memory/state reuse
- automatic Python venv creation
- model download/management
- GPU/backend auto-discovery
- production-grade usage accounting
