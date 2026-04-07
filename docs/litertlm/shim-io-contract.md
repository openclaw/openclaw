# LiteRT-LM Shim I/O Contract

## Purpose

Define a minimal, merge-friendly contract between `extensions/litertlm/src/stream.ts` and a Python shim process.

The goal is to keep the OpenClaw side thin, config-driven, and explicit about failures.

## Scope

This contract is for the **experimental one-shot text generation path** only.

### In scope
- one request in
- one response out
- structured JSON input/output
- clear configuration, environment, and runtime errors

### Not in scope
- token streaming
- multi-turn state reuse
- model download/management
- automatic Python environment setup
- GPU/backend negotiation beyond explicit shim support

## Ownership boundary

OpenClaw owns:
- provider registration
- request normalization
- shim path/python path resolution
- subprocess invocation
- parsing shim JSON
- mapping shim failures into OpenClaw errors

The Python shim owns:
- loading the LiteRT-LM runtime
- loading the target model
- executing inference
- returning structured JSON output

## Transport

- Invocation: subprocess via `execFile`
- Encoding: UTF-8 JSON
- Recommended transport: **stdin JSON in, stdout JSON out**
- stderr: diagnostics only, not part of the contract payload

## Request contract

Example request payload:

```json
{
  "version": 1,
  "requestId": "req_123",
  "model": {
    "id": "litertlm/gemma4-e2b-edge-gallery",
    "file": "/absolute/path/to/model.litertlm"
  },
  "runtime": {
    "backend": "CPU",
    "timeoutMs": 120000
  },
  "input": {
    "system": "You are a helpful assistant.",
    "prompt": "Summarize this paragraph.",
    "messages": []
  },
  "options": {
    "maxOutputTokens": 512,
    "temperature": 0.2
  }
}
```

### Required fields
- `version`
- `model.id`
- `model.file`
- `input.prompt` or a non-empty `input.messages`

### Optional fields
- `requestId`
- `input.system`
- `input.messages`
- `runtime.backend`
- `runtime.timeoutMs`
- `options.maxOutputTokens`
- `options.temperature`

## Response contract

### Success

```json
{
  "ok": true,
  "version": 1,
  "requestId": "req_123",
  "model": {
    "id": "litertlm/gemma4-e2b-edge-gallery"
  },
  "output": {
    "text": "Here is the summary...",
    "stopReason": "stop"
  },
  "usage": {
    "inputTokens": 0,
    "outputTokens": 0,
    "totalTokens": 0
  },
  "diagnostics": {
    "backend": "CPU"
  }
}
```

### Failure

```json
{
  "ok": false,
  "version": 1,
  "requestId": "req_123",
  "error": {
    "type": "configuration",
    "code": "MODEL_FILE_MISSING",
    "message": "litertlm model file was not provided"
  }
}
```

## Error types

### `configuration`
Use when OpenClaw or the caller supplied invalid or incomplete config.

Examples:
- missing model file
- invalid shim path
- invalid request payload

### `environment`
Use when the local machine/runtime is not ready.

Examples:
- Python executable missing
- LiteRT-LM import failed
- dependency not installed

### `runtime`
Use when invocation reached inference but failed during execution.

Examples:
- model load failure
- inference failure
- non-zero runtime crash
- timeout

## Recommended error codes

- `MODEL_FILE_MISSING`
- `INVALID_REQUEST`
- `PYTHON_NOT_FOUND`
- `SHIM_IMPORT_FAILED`
- `MODEL_LOAD_FAILED`
- `INFERENCE_FAILED`
- `PROCESS_TIMEOUT`
- `UNKNOWN_RUNTIME_ERROR`

## OpenClaw mapping rules

OpenClaw should:
- treat `ok: true` as a successful one-shot text result
- treat `ok: false` as a structured provider failure
- surface `error.message` directly when actionable
- avoid relying on stderr parsing for normal control flow

## Path/config resolution policy

Recommended resolution order:
1. explicit provider config
2. environment variables
3. safe defaults

Suggested config fields:

```json
{
  "providers": {
    "litertlm": {
      "pythonPath": "python3",
      "shimPath": "extensions/litertlm/scripts/litertlm_provider_shim.py",
      "modelFile": "/absolute/path/to/model.litertlm",
      "timeoutMs": 120000
    }
  }
}
```

## Minimal merge-ready expectation

To make the current experimental provider more mergeable, the repo should eventually align `stream.ts` and the shim to this contract instead of relying on:
- hardcoded `python3`
- hardcoded repo-root shim path assumptions
- ad hoc `--input <json>` only transport without versioned response schema
- implicit environment assumptions tied to one local machine
