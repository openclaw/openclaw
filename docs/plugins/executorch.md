---
summary: "ExecuTorch plugin: on-device Parakeet-TDT speech-to-text for inbound audio and macOS Talk Mode"
read_when:
  - You want local on-device STT instead of a cloud provider
  - You are enabling the bundled ExecuTorch plugin
  - You want to use Parakeet-TDT with macOS Talk Mode
title: "ExecuTorch Plugin"
---

# ExecuTorch (plugin)

On-device speech-to-text for OpenClaw using an embedded ExecuTorch runtime.

Current bundled model plugin:

- `parakeet` (`Parakeet-TDT`)

Quick mental model:

- Enable the bundled plugin
- Download the runtime + model files once
- Point `tools.media.audio.models` at `provider: "executorch"`
- Optionally switch macOS Talk Mode to the ExecuTorch STT backend

## Scope

Current support:

- Platform: macOS Apple Silicon (`darwin/arm64`)
- Backend: `metal`
- Runtime mode: embedded runtime (no subprocess in the plugin path)
- Audio provider id: `executorch`
- Default model id: `parakeet-tdt-0.6b-v3`

## Where it runs

The ExecuTorch plugin runs inside the OpenClaw process.

- For inbound media transcription, it registers a local media provider.
- For macOS Talk Mode, the app uses the same Parakeet runtime artifacts when you
  switch the STT backend to `executorch`.

If your Gateway is already running, restart it after enabling the plugin so the
runtime media provider is loaded.

## Prerequisites

- macOS Apple Silicon
- Hugging Face CLI (`hf`) installed and available on `PATH`

The setup flow shells out to:

```bash
hf download ...
```

If you do not already have it:

```bash
pip install huggingface_hub
```

## Enable the bundled plugin

```bash
openclaw plugins list
openclaw plugins info executorch
openclaw plugins enable executorch
```

## One-command setup

After enabling the plugin:

```bash
openclaw executorch setup --backend metal
openclaw executorch status
openclaw executorch transcribe /path/to/short.wav
```

What `setup` downloads:

- `model.pte`
- `tokenizer.model`
- `libparakeet_tdt_runtime.dylib`

Source repo:

- [HF Hub: Parakeet-TDT-ExecuTorch-Metal](https://huggingface.co/younghan-meta/Parakeet-TDT-ExecuTorch-Metal)

## Default paths

- Runtime library:
  - `~/.openclaw/lib/libparakeet_tdt_runtime.dylib`
- Model root:
  - `~/.openclaw/models/parakeet`
- Default model directory:
  - `~/.openclaw/models/parakeet/parakeet-tdt-metal`
- Default model file:
  - `~/.openclaw/models/parakeet/parakeet-tdt-metal/model.pte`
- Default tokenizer file:
  - `~/.openclaw/models/parakeet/parakeet-tdt-metal/tokenizer.model`

## Config

Plugin config lives under `plugins.entries.executorch.config`.

```json5
{
  plugins: {
    entries: {
      executorch: {
        enabled: true,
        config: {
          modelPlugin: "parakeet",
          backend: "metal",
          runtimeLibraryPath: "~/.openclaw/lib/libparakeet_tdt_runtime.dylib",
          modelDir: "~/.openclaw/models/parakeet/parakeet-tdt-metal",
          modelPath: "~/.openclaw/models/parakeet/parakeet-tdt-metal/model.pte",
          tokenizerPath: "~/.openclaw/models/parakeet/parakeet-tdt-metal/tokenizer.model",
        },
      },
    },
  },
}
```

Supported config keys:

- `modelPlugin`
- `backend`
- `runtimeLibraryPath`
- `modelDir`
- `modelPath`
- `tokenizerPath`
- `dataPath`

Supported values today:

- `modelPlugin: "parakeet"`
- `backend: "metal"`

## Use it for inbound audio transcription

The plugin registers a local media provider named `executorch`.

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "executorch", model: "parakeet-tdt-0.6b-v3" }],
      },
    },
  },
}
```

Notes:

- `model` is optional here; `parakeet-tdt-0.6b-v3` is the plugin default.
- This is a local provider, so you do not need `models.providers.executorch.apiKey`.
- ExecuTorch is not part of the built-in audio auto-detection order; enable the
  plugin explicitly and run setup first.

See:

- [Speech-to-Text](/stt)
- [Audio / Voice Notes](/nodes/audio)
- [Media Understanding](/nodes/media-understanding)

## macOS Talk Mode

Talk Mode uses Apple Speech by default for speech recognition on macOS. After the
ExecuTorch runtime files are available, you can switch Talk Mode STT to the local
Parakeet backend:

```bash
defaults write <bundle-id> openclaw.talkSttBackend executorch
```

Example for a dev app bundle:

```bash
defaults write ai.openclaw.mac.debug openclaw.talkSttBackend executorch
```

Then fully relaunch the app.

To switch back:

```bash
defaults write <bundle-id> openclaw.talkSttBackend apple
```

Notes:

- Supported values are `apple` and `executorch`.
- If ExecuTorch load/startup fails, Talk Mode falls back to Apple Speech.
- Talk STT backend selection is separate from Talk TTS configuration under `talk`.

See:

- [Talk Mode](/nodes/talk)

## CLI

```bash
openclaw executorch status
openclaw executorch setup --backend metal
openclaw executorch setup --backend metal --model-dir /path/to/model-dir
openclaw executorch transcribe /path/to/audio.wav
```

`setup` options:

- `--backend <backend>`
- `--model-dir <dir>`

## Environment overrides

- `OPENCLAW_EXECUTORCH_RUNTIME_LIBRARY`
- `OPENCLAW_EXECUTORCH_MODEL_ROOT`
- `OPENCLAW_EXECUTORCH_NATIVE_ADDON`

## Troubleshooting

### `openclaw executorch status` shows missing files

Run:

```bash
openclaw executorch setup --backend metal
```

Then verify the default paths under `~/.openclaw/lib` and
`~/.openclaw/models/parakeet/parakeet-tdt-metal`.

### Native addon missing

Symptoms:

- `Parakeet native addon not found`

Fix:

```bash
cd extensions/executorch
npm install
```

Or point `OPENCLAW_EXECUTORCH_NATIVE_ADDON` at a built addon path.

### Runtime dylib load failures

Common causes:

- wrong architecture
- missing runtime dependencies
- mixing runtime/model files from different builds

Re-run setup and keep the model files plus runtime library from the same Hugging
Face repo/version.

### Unsupported host

Current support is intentionally limited to `darwin/arm64` with `metal`.
