# ExecuTorch Parakeet Plugin for OpenClaw

On-device speech-to-text (STT) for OpenClaw using an embedded ExecuTorch runtime with **Parakeet-TDT** on **Metal**.

## Scope

- Backend: `metal` only
- Platform: macOS Apple Silicon (`darwin/arm64`)
- Runtime mode: embedded (native addon + C ABI dylib)
- No subprocess runner in the plugin path

## Required Artifacts

Source repo:

- [https://huggingface.co/younghan-meta/Parakeet-TDT-ExecuTorch-Metal](https://huggingface.co/younghan-meta/Parakeet-TDT-ExecuTorch-Metal)

Required files:

- `model.pte`
- `tokenizer.model`
- `libparakeet_tdt_runtime.dylib`

## One-Command Setup Flow

From the OpenClaw repo root:

```bash
pnpm openclaw config set plugins.entries.executorch.enabled true
pnpm openclaw executorch setup
pnpm openclaw executorch status
```

Then verify transcription:

```bash
pnpm openclaw executorch transcribe /path/to/short.wav
```

## Default Paths

- Runtime library:
  - `~/.openclaw/lib/libparakeet_tdt_runtime.dylib`
- Model root:
  - `~/.openclaw/models/parakeet/parakeet-tdt-metal`
- Default model file:
  - `~/.openclaw/models/parakeet/parakeet-tdt-metal/model.pte`
- Default tokenizer file:
  - `~/.openclaw/models/parakeet/parakeet-tdt-metal/tokenizer.model`

## Plugin Config (Optional Overrides)

`plugins.entries.executorch` supports:

- `enabled`: boolean
- `backend`: `"metal"` (only value accepted in this migration)
- `runtimeLibraryPath`: string
- `modelDir`: string
- `modelPath`: string
- `tokenizerPath`: string
- `dataPath`: string (optional)

Example:

```json
{
  "plugins": {
    "entries": {
      "executorch": {
        "enabled": true,
        "backend": "metal",
        "runtimeLibraryPath": "/Users/me/.openclaw/lib/libparakeet_tdt_runtime.dylib",
        "modelPath": "/Users/me/.openclaw/models/parakeet/parakeet-tdt-metal/model.pte",
        "tokenizerPath": "/Users/me/.openclaw/models/parakeet/parakeet-tdt-metal/tokenizer.model"
      }
    }
  }
}
```

## Native Addon Build

The extension builds a native addon during `npm install` / `pnpm install`:

- output: `extensions/executorch/build/Release/parakeet_runtime.node`

If addon build fails, run:

```bash
cd extensions/executorch
npm install
```

## macOS Talk Mode

To use ExecuTorch backend in the macOS app:

```bash
defaults write ai.openclaw.mac.debug openclaw.talkSttBackend executorch
```

Then fully relaunch the app.

Talk Mode now uses the same embedded Parakeet runtime ABI and offline rolling-window decode strategy used by the plugin runtime.

## Troubleshooting

### `executorch status` shows missing files

Run:

```bash
pnpm openclaw executorch setup
```

If still missing, verify filesystem paths under `~/.openclaw/lib` and `~/.openclaw/models/parakeet/parakeet-tdt-metal`.

### Native addon missing

Symptoms:

- `"Parakeet native addon not found"` errors

Fix:

```bash
cd extensions/executorch
npm install
```

### Runtime dylib load failures

Common causes:

- wrong architecture
- missing dependencies (e.g. OpenMP runtime)
- incompatible runtime/model artifact mix

Re-run setup and ensure all artifacts come from the same HF repo/version.

### Host unsupported

This migration path is intentionally metal-only. Non-`darwin/arm64` hosts log a disabled-plugin warning.

## Developer Notes

- Native addon loads C ABI symbols:
  - `pqt_runner_create`
  - `pqt_runner_destroy`
  - `pqt_runner_transcribe`
  - `pqt_last_error`
- Plugin default model id: `parakeet-tdt-0.6b-v3`
