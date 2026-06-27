---
name: sherpa-onnx-tts
description: "Install and use local text-to-speech via sherpa-onnx (offline, no cloud)"
metadata:
  {
    "openclaw":
      {
        "emoji": "🔉",
        "os": ["darwin", "linux", "win32"],
        "install":
          [
            {
              "id": "download-runtime-macos",
              "kind": "download",
              "os": ["darwin"],
              "url": "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.2/sherpa-onnx-v1.13.2-osx-universal2-shared.tar.bz2",
              "archive": "tar.bz2",
              "extract": true,
              "stripComponents": 1,
              "targetDir": "runtime",
              "label": "Step 1: Download sherpa-onnx runtime (macOS)",
            },
            {
              "id": "download-runtime-linux-x64",
              "kind": "download",
              "os": ["linux"],
              "url": "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.2/sherpa-onnx-v1.13.2-linux-x64-shared.tar.bz2",
              "archive": "tar.bz2",
              "extract": true,
              "stripComponents": 1,
              "targetDir": "runtime",
              "label": "Step 1: Download sherpa-onnx runtime (Linux x64)",
            },
            {
              "id": "download-runtime-win-x64",
              "kind": "download",
              "os": ["win32"],
              "url": "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.2/sherpa-onnx-v1.13.2-win-x64-shared-MD-Release.tar.bz2",
              "archive": "tar.bz2",
              "extract": true,
              "stripComponents": 1,
              "targetDir": "runtime",
              "label": "Step 1: Download sherpa-onnx runtime (Windows x64)",
            },
            {
              "id": "download-model-lessac",
              "kind": "download",
              "url": "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-lessac-high.tar.bz2",
              "archive": "tar.bz2",
              "extract": true,
              "targetDir": "models",
              "label": "Step 2: Download Piper en_US lessac (high)",
            },
          ],
      },
  }
---

# sherpa-onnx-tts

Local TTS using the sherpa-onnx offline CLI.

## Install

Run the gateway-backed skill dependency download actions for your OS. The
installer runs one action at a time:

1. Download the runtime for your OS.
2. Download the Piper `en_US-lessac-high` voice model.

Use `download-runtime-macos`, `download-runtime-linux-x64`, or
`download-runtime-win-x64`, then `download-model-lessac`:

```bash
openclaw gateway call skills.install --timeout 900000 --params '{"name":"sherpa-onnx-tts","installId":"download-runtime-macos","timeoutMs":900000}'
openclaw gateway call skills.install --timeout 900000 --params '{"name":"sherpa-onnx-tts","installId":"download-model-lessac","timeoutMs":900000}'
```

For manual installs, the runtime directory must contain
`bin/sherpa-onnx-offline-tts` (or the Windows `.exe`); the model directory must
contain one `.onnx` model, `tokens.txt`, and `espeak-ng-data`.

The wrapper uses the downloaded paths under the active OpenClaw config
directory. OpenClaw resolves that directory from `$OPENCLAW_STATE_DIR`, then
the directory containing `$OPENCLAW_CONFIG_PATH`, then
`$OPENCLAW_HOME/.openclaw` or `~/.openclaw`.

With the default config directory, the downloaded paths are:

- `~/.openclaw/tools/sherpa-onnx-tts/runtime`
- `~/.openclaw/tools/sherpa-onnx-tts/models/vits-piper-en_US-lessac-high`

Set `SHERPA_ONNX_RUNTIME_DIR` or `SHERPA_ONNX_MODEL_DIR` when using custom
paths or a manual Linux/Windows installation.

The wrapper lives in this skill folder. Run it directly, or add the wrapper to PATH:

```bash
export PATH="{baseDir}/bin:$PATH"
```

## Usage

```bash
{baseDir}/bin/sherpa-onnx-tts -o ./tts.wav "Hello from local TTS."
```

## Security limitation

Sherpa ONNX v1.13.2 accepts synthesized text only as a native process argument,
which local process inspection can expose. Treat wrapper text as observable on
the host and do not use it for sensitive content.

Notes:

- Pick a different model from the sherpa-onnx `tts-models` release if you want another voice.
- If the model dir has multiple `.onnx` files, set `SHERPA_ONNX_MODEL_FILE` or pass `--model-file`.
- You can also pass `--tokens-file` or `--data-dir` to override the defaults.
- Windows: run `node {baseDir}\\bin\\sherpa-onnx-tts -o tts.wav "Hello from local TTS."`
