---
summary: "Adds text-to-speech provider support."
read_when:
  - You are installing, configuring, or auditing the tts-local-cli plugin
title: "TTS Local CLI plugin"
---

# TTS Local CLI plugin

Adds local text-to-speech provider support for Talk mode, outbound TTS, and voice-note delivery.

## Distribution

- Package: `@openclaw/tts-local-cli`
- Install route: included in OpenClaw

## Surface

contracts: speechProviders

Provider ids and aliases:

- `tts-local-cli`
- `local-voice`
- `local`
- `piper`
- `say`
- `cli`

## Engines

`tts-local-cli` supports four engine modes:

- `piper`: runs a local Piper executable with a local `.onnx` voice model.
- `say`: runs macOS `say` with a selected system voice.
- `command`: runs a fully custom local command, preserving the original plugin behavior.
- `auto`: prefers Piper when a model path or model directory is configured, then falls back to macOS `say`.

## Talk Config Examples

Piper:

```json5
{
  talk: {
    provider: "local-voice",
    providers: {
      "local-voice": {
        engine: "piper",
        executable: "piper",
        modelPath: "~/.openclaw/models/piper/nl_NL-mls-medium.onnx",
        outputFormat: "wav",
      },
    },
    speechLocale: "nl-NL",
  },
}
```

macOS fallback:

```json5
{
  talk: {
    provider: "local-voice",
    providers: {
      "local-voice": {
        engine: "say",
        voiceId: "Xander",
        outputFormat: "wav",
      },
    },
    speechLocale: "nl-NL",
  },
}
```

Custom command:

```json5
{
  messages: {
    tts: {
      provider: "tts-local-cli",
      providers: {
        "tts-local-cli": {
          command: "/usr/local/bin/my-tts",
          args: ["--text", "{{Text}}", "--out", "{{OutputPath}}"],
          outputFormat: "wav",
        },
      },
    },
  },
}
```

Template values available in `args`:

- `{{Text}}`
- `{{OutputPath}}`
- `{{OutputDir}}`
- `{{OutputBase}}`
- `{{VoiceId}}`
- `{{ModelPath}}`

When `{{Text}}` is not present in the command arguments, the provider writes the spoken text to stdin.

## Piper Fields

- `executable` or `piperExecutable`: Piper binary path. Defaults to `piper`.
- `modelPath` or `piperModelPath`: direct `.onnx` model path.
- `modelDir` or `piperModelDir`: directory to search for `<voiceId>.onnx`.
- `configPath`: optional Piper model config JSON.
- `voiceId`: model basename when `modelPath` is not set.
- `speed`: Talk speed multiplier. For Piper this maps to `length_scale`.
- `speaker`, `noiseScale`, `noiseW`, `sentenceSilence`, `dataDir`: passed through to Piper.

## macOS Say Fields

- `executable` or `sayExecutable`: `say` binary path. Defaults to `say`.
- `voiceId`, `voiceName`, or `voice`: system voice name, for example `Xander`.
- `speed` or `rateWpm`: speaking rate.
- `dataFormat`: `say --data-format` value. Defaults to `LEI16@22050`.

## Output

The local engines default to WAV because it is the lowest-friction local playback format. `mp3` and `opus` remain available when `ffmpeg` is installed.
