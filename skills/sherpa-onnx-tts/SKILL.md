---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: sherpa-onnx-tts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Local text-to-speech via sherpa-onnx (offline, no cloud)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "openclaw":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "emoji": "🗣️",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "os": ["darwin", "linux", "win32"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "requires": { "env": ["SHERPA_ONNX_RUNTIME_DIR", "SHERPA_ONNX_MODEL_DIR"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "install":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "id": "download-runtime-macos",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "kind": "download",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "os": ["darwin"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "url": "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.12.23/sherpa-onnx-v1.12.23-osx-universal2-shared.tar.bz2",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "archive": "tar.bz2",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "extract": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "stripComponents": 1,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "targetDir": "~/.openclaw/tools/sherpa-onnx-tts/runtime",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "label": "Download sherpa-onnx runtime (macOS)",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "id": "download-runtime-linux-x64",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "kind": "download",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "os": ["linux"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "url": "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.12.23/sherpa-onnx-v1.12.23-linux-x64-shared.tar.bz2",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "archive": "tar.bz2",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "extract": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "stripComponents": 1,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "targetDir": "~/.openclaw/tools/sherpa-onnx-tts/runtime",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "label": "Download sherpa-onnx runtime (Linux x64)",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "id": "download-runtime-win-x64",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "kind": "download",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "os": ["win32"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "url": "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.12.23/sherpa-onnx-v1.12.23-win-x64-shared.tar.bz2",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "archive": "tar.bz2",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "extract": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "stripComponents": 1,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "targetDir": "~/.openclaw/tools/sherpa-onnx-tts/runtime",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "label": "Download sherpa-onnx runtime (Windows x64)",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "id": "download-model-lessac",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "kind": "download",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "url": "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-lessac-high.tar.bz2",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "archive": "tar.bz2",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "extract": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "targetDir": "~/.openclaw/tools/sherpa-onnx-tts/models",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "label": "Download Piper en_US lessac (high)",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# sherpa-onnx-tts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Local TTS using the sherpa-onnx offline CLI.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Download the runtime for your OS (extracts into `~/.openclaw/tools/sherpa-onnx-tts/runtime`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Download a voice model (extracts into `~/.openclaw/tools/sherpa-onnx-tts/models`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Update `~/.openclaw/openclaw.json`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  skills: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    entries: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "sherpa-onnx-tts": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        env: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          SHERPA_ONNX_RUNTIME_DIR: "~/.openclaw/tools/sherpa-onnx-tts/runtime",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          SHERPA_ONNX_MODEL_DIR: "~/.openclaw/tools/sherpa-onnx-tts/models/vits-piper-en_US-lessac-high",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The wrapper lives in this skill folder. Run it directly, or add the wrapper to PATH:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export PATH="{baseDir}/bin:$PATH"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Usage（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{baseDir}/bin/sherpa-onnx-tts -o ./tts.wav "Hello from local TTS."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Pick a different model from the sherpa-onnx `tts-models` release if you want another voice.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If the model dir has multiple `.onnx` files, set `SHERPA_ONNX_MODEL_FILE` or pass `--model-file`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- You can also pass `--tokens-file` or `--data-dir` to override the defaults.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Windows: run `node {baseDir}\\bin\\sherpa-onnx-tts -o tts.wav "Hello from local TTS."`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
