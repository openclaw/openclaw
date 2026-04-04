# LiteRT-LM OpenClaw Config / Registration Draft

## Goal

Describe how the validated LiteRT-LM local model path could be represented as an experimental OpenClaw model registration.

## Key assumption

OpenClaw would call a **process-based shim** instead of embedding LiteRT-LM directly in-process for the first experimental version.

Current shim entry:
- `python3 scripts/litertlm_provider_shim.py --input '<json>'`

## Suggested experimental model ids

- `litertlm/gemma4-e2b-edge-gallery` — recommended first/default experimental registration
- `litertlm/gemma4-e4b-edge-gallery` — validated as functional, but recommended only as an optional experimental registration for now

These model ids represent:
- LiteRT-LM runtime
- local `.litertlm` files downloaded by Edge Gallery
- process-based experimental adapter

## Suggested config concepts

### Model registration metadata

```json
{
  "id": "litertlm/gemma4-e2b-edge-gallery",
  "kind": "experimental-local-model",
  "displayName": "Gemma 4 E2B (LiteRT-LM via Edge Gallery download)",
  "runtime": "process-shim",
  "entry": "scripts/litertlm_provider_shim.py",
  "backend": "CPU",
  "modelPathStrategy": "edge-gallery-autodetect"
}
```

## Suggested request mapping

### OpenClaw-side request

```json
{
  "prompt": "Reply with exactly: hello",
  "system": "You are concise."
}
```

### Shim input

```json
{
  "prompt": "Reply with exactly: hello",
  "system": "You are concise.",
  "backend": "CPU"
}
```

### Optional explicit model override

```json
{
  "prompt": "Reply with exactly: hello",
  "system": "You are concise.",
  "model": "/Users/arvinku/.../Gemma_4_E4B_it/...litertlm",
  "backend": "CPU"
}
```

## Suggested response mapping

### Shim output

```json
{
  "ok": true,
  "model": "/resolved/path/to/model.litertlm",
  "backend": "CPU",
  "output_text": "hello",
  "raw_response": {
    "content": [
      {
        "text": "hello",
        "type": "text"
      }
    ],
    "role": "assistant"
  },
  "diagnostics": {
    "model_source": "auto",
    "resolved_model": "/resolved/path/to/model.litertlm",
    "python_executable": "/tmp/litertlm-venv/bin/python"
  }
}
```

### OpenClaw-side normalized result

```json
{
  "text": "hello",
  "model": "litertlm/gemma4-e2b-edge-gallery",
  "provider": "litertlm-local-experimental",
  "diagnostics": {
    "resolved_model": "/resolved/path/to/model.litertlm",
    "backend": "CPU"
  }
}
```

## Suggested error mapping

### Shim error example

```json
{
  "ok": false,
  "error": {
    "code": "runtime_missing",
    "message": "No Python interpreter with litert_lm available. Run setup first."
  },
  "diagnostics": {
    "runtime_resolver": {
      "selected": null,
      "checked": []
    }
  }
}
```

### OpenClaw-side error interpretation

Map to a user-facing error like:
- local model runtime missing
- local model file missing
- invalid experimental backend input
- local generation failure

## Recommended first registration behavior

### Behavior
- mark model as experimental
- disable by default unless explicitly enabled
- prefer explicit selection, not silent fallback
- surface diagnostics in logs or debug panel

### Why
Because this path still depends on:
- a Python runtime
- a machine-local venv / package install
- a local Edge Gallery model download path

## Suggested settings block

Example draft shape:

```json
{
  "experimentalLocalModels": {
    "litertlm": {
      "enabled": true,
      "pythonStrategy": "autodetect",
      "providerShim": "scripts/litertlm_provider_shim.py",
      "defaultBackend": "CPU",
      "models": {
        "litertlm/gemma4-e2b-edge-gallery": {
          "displayName": "Gemma 4 E2B (LiteRT-LM)",
          "pathStrategy": "edge-gallery-autodetect",
          "preferredMatch": "Gemma_4_E2B_it"
        },
        "litertlm/gemma4-e4b-edge-gallery": {
          "displayName": "Gemma 4 E4B (LiteRT-LM)",
          "pathStrategy": "edge-gallery-autodetect",
          "preferredMatch": "Gemma_4_E4B_it"
        }
      }
    }
  }
}
```

## Recommended next code step

If this moves beyond design, the next implementation task should be:
- a tiny OpenClaw-side adapter that shells out to `litertlm_provider_shim.py`
- maps success/error JSON
- exposes one experimental local model id first, preferably E2B

## Recommendation

Start with one model registration first:
- `litertlm/gemma4-e2b-edge-gallery`

E4B has now been practically validated as functional on this machine through the wrapper path, but current recommendation remains:
- keep E2B as the default experimental registration
- expose E4B only as an optional secondary experimental model
- defer making E4B the default until repeated-run latency and comfort are better understood
