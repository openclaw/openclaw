---
summary: "The tts config block, per-provider settings, local speech engines, and override precedence"
title: "Text-to-speech configuration"
read_when:
  - You are writing the tts block in openclaw.json
  - You need the config snippet for one speech provider
  - You want a local Speech Swift or speech-core engine
  - You need per-agent, per-channel, or per-account voice overrides
---

## Configuration

TTS config lives under `tts` in `~/.openclaw/openclaw.json`. Pick a
preset and adapt the provider block. The `speakerVoice`/`speakerVoiceId`
fields shown below are canonical; each provider's own `voice`/`voiceId`/
`voiceName` field names still work as legacy aliases.

OpenRouter and DeepInfra use the first nonblank value from `speakerVoice`,
`speakerVoiceId`, `voice`, and `voiceId`, in that order, before the provider default.
Talk applies the same order to its provider block; when all four fields are absent
or blank, it keeps the base TTS voice.

<Tabs>
  <Tab title="Azure Speech">
```json5
{
  tts: {
    auto: "always",
    provider: "azure-speech",
    providers: {
      "azure-speech": {
        apiKey: "${AZURE_SPEECH_KEY}",
        region: "eastus",
        speakerVoice: "en-US-JennyNeural",
        lang: "en-US",
        outputFormat: "audio-24khz-48kbitrate-mono-mp3",
        voiceNoteOutputFormat: "ogg-24khz-16bit-mono-opus",
      },
    },
  },
}
```
  </Tab>
  <Tab title="ElevenLabs">
```json5
{
  tts: {
    auto: "always",
    provider: "elevenlabs",
    providers: {
      elevenlabs: {
        apiKey: "${ELEVENLABS_API_KEY}",
        model: "eleven_multilingual_v2",
        speakerVoiceId: "EXAVITQu4vr4xnSDxMaL",
      },
    },
  },
}
```
  </Tab>
  <Tab title="Fish Audio">
```json5
{
  tts: {
    auto: "tagged",
    provider: "fish-audio",
    providers: {
      "fish-audio": {
        apiKey: "${FISH_API_KEY}",
        model: "s2.1-pro",
        speakerVoiceId: "802e3bc2b27e49c2995d23ef70e6ac89",
        latency: "balanced",
      },
    },
  },
}
```
  </Tab>
  <Tab title="Google Gemini">
```json5
{
  tts: {
    auto: "always",
    provider: "google",
    providers: {
      google: {
        apiKey: "${GEMINI_API_KEY}",
        model: "gemini-3.1-flash-tts-preview",
        speakerVoice: "Kore",
        // Optional natural-language style prompts:
        // audioProfile: "Speak in a calm, podcast-host tone.",
        // speakerName: "Alex",
      },
    },
  },
}
```
  </Tab>
  <Tab title="Gradium">
```json5
{
  tts: {
    auto: "always",
    provider: "gradium",
    providers: {
      gradium: {
        apiKey: "${GRADIUM_API_KEY}",
        speakerVoiceId: "YTpq7expH9539ERJ",
      },
    },
  },
}
```
  </Tab>
  <Tab title="Inworld">
```json5
{
  tts: {
    auto: "always",
    provider: "inworld",
    providers: {
      inworld: {
        apiKey: "${INWORLD_API_KEY}",
        modelId: "inworld-tts-1.5-max",
        speakerVoiceId: "Sarah",
        temperature: 0.7,
      },
    },
  },
}
```
  </Tab>
  <Tab title="Local CLI">
```json5
{
  tts: {
    auto: "always",
    provider: "tts-local-cli",
    providers: {
      "tts-local-cli": {
        command: "say",
        args: ["-o", "{{OutputPath}}", "{{Text}}"],
        outputFormat: "wav",
        timeoutMs: 120000,
      },
    },
  },
}
```
  </Tab>
  <Tab title="Microsoft (no key)">
```json5
{
  tts: {
    auto: "always",
    provider: "microsoft",
    providers: {
      microsoft: {
        enabled: true,
        speakerVoice: "en-US-MichelleNeural",
        lang: "en-US",
        outputFormat: "audio-24khz-48kbitrate-mono-mp3",
        rate: "+0%",
        pitch: "+0%",
      },
    },
  },
}
```
  </Tab>
  <Tab title="MiniMax">
```json5
{
  tts: {
    auto: "always",
    provider: "minimax",
    providers: {
      minimax: {
        apiKey: "${MINIMAX_API_KEY}",
        model: "speech-2.8-hd",
        speakerVoiceId: "English_expressive_narrator",
        speed: 1.0,
        vol: 1.0,
        pitch: 0,
      },
    },
  },
}
```
  </Tab>
  <Tab title="OpenAI + ElevenLabs">
```json5
{
  tts: {
    auto: "always",
    provider: "openai",
    summaryModel: "openai/gpt-4.1-mini",
    modelOverrides: { enabled: true },
    providers: {
      openai: {
        apiKey: "${OPENAI_API_KEY}",
        model: "gpt-4o-mini-tts",
        speakerVoice: "alloy",
      },
      elevenlabs: {
        apiKey: "${ELEVENLABS_API_KEY}",
        model: "eleven_multilingual_v2",
        speakerVoiceId: "EXAVITQu4vr4xnSDxMaL",
        voiceSettings: { stability: 0.5, similarityBoost: 0.75, style: 0.0, useSpeakerBoost: true, speed: 1.0 },
        applyTextNormalization: "auto",
        languageCode: "en",
      },
    },
  },
}
```
  </Tab>
  <Tab title="OpenRouter">
```json5
{
  tts: {
    auto: "always",
    provider: "openrouter",
    providers: {
      openrouter: {
        apiKey: "${OPENROUTER_API_KEY}",
        model: "hexgrad/kokoro-82m",
        speakerVoice: "af_alloy",
        responseFormat: "mp3",
      },
    },
  },
}
```
  </Tab>
  <Tab title="Volcengine">
```json5
{
  tts: {
    auto: "always",
    provider: "volcengine",
    providers: {
      volcengine: {
        apiKey: "${VOLCENGINE_TTS_API_KEY}",
        resourceId: "seed-tts-1.0",
        speakerVoice: "en_female_anna_mars_bigtts",
      },
    },
  },
}
```
  </Tab>
  <Tab title="xAI">
```json5
{
  tts: {
    auto: "always",
    provider: "xai",
    providers: {
      xai: {
        apiKey: "${XAI_API_KEY}",
        speakerVoiceId: "eve",
        language: "en",
        responseFormat: "mp3",
      },
    },
  },
}
```
  </Tab>
  <Tab title="Xiaomi MiMo">
```json5
{
  tts: {
    auto: "always",
    provider: "xiaomi",
    providers: {
      xiaomi: {
        apiKey: "${XIAOMI_API_KEY}",
        model: "mimo-v2.5-tts",
        speakerVoice: "mimo_default",
        format: "mp3",
      },
    },
  },
}
```
  </Tab>
</Tabs>

For Xiaomi `mimo-v2.5-tts-voicedesign`, omit `speakerVoice` and set `style` to
the voice-design prompt. OpenClaw sends that prompt as the TTS `user` message
and does not send `audio.voice` for the voicedesign model.

### Local Speech Swift and speech-core

[Speech Swift](https://github.com/soniqo/speech-swift) and
[speech-core](https://github.com/soniqo/speech-core) provide local speech
inference across macOS, Linux, and Windows. Use the OpenAI-compatible HTTP
provider when Speech Swift and OpenClaw run on the same Mac. Use Local CLI for
direct executable integration on any supported host.

Install `ffmpeg` when a channel needs OpenClaw to convert WAV output to Opus or
raw PCM.

<Tabs>
  <Tab title="macOS HTTP">
<Warning>
This HTTP setup requires Speech Swift v0.0.23 or later. If Homebrew already
installed an older version, run `brew update && brew upgrade speech` first.
</Warning>

Start Speech Swift's local server:

```bash
brew install speech
speech-server --port 8080
```

Point the OpenAI speech provider at its loopback endpoint. `responseFormat`
must be `wav` because the local endpoint does not emit compressed audio:

```json5
{
  tts: {
    auto: "always",
    provider: "openai",
    providers: {
      openai: {
        apiKey: "local",
        baseUrl: "http://127.0.0.1:8080/v1",
        model: "tts-1",
        speakerVoice: "alloy",
        responseFormat: "wav",
      },
    },
  },
}
```

`tts-1` selects Kokoro. Speech Swift registry aliases such as `qwen3-tts`,
`cosyvoice`, and `voxcpm2` select other local engines. The placeholder API key
is required by OpenClaw's provider configuration but is not validated by the
loopback server.
</Tab>
<Tab title="macOS CLI">
The Homebrew `speech` executable can write directly to OpenClaw's
per-invocation output path:

```json5
{
  tts: {
    auto: "always",
    provider: "tts-local-cli",
    providers: {
      "tts-local-cli": {
        command: "speech",
        args: ["speak", "{{Text}}", "--output", "{{OutputPath}}"],
        outputFormat: "wav",
        timeoutMs: 120000,
      },
    },
  },
}
```

  </Tab>
  <Tab title="Linux CLI">
Install a speech-core Linux release package, download the ONNX model set once,
and verify synthesis before starting OpenClaw:

```bash
speech download-models
speech speak "Hello from OpenClaw" hello.wav
```

Then configure the packaged Kokoro command:

```json5
{
  tts: {
    auto: "always",
    provider: "tts-local-cli",
    providers: {
      "tts-local-cli": {
        command: "speech",
        args: ["speak", "{{Text}}", "{{OutputPath}}"],
        outputFormat: "wav",
        timeoutMs: 120000,
      },
    },
  },
}
```

See the [speech-core Linux CLI reference](https://github.com/soniqo/speech-core/blob/main/docs/cli.md)
for release packages and model-directory settings.
</Tab>
<Tab title="Windows CLI">
Download the speech-core Windows release, extract it, and install the ONNX
models once:

```powershell
$Version = "0.0.11"
$Url = "https://github.com/soniqo/speech-core/releases/download/v$Version/speech-$Version-windows-x64.zip"
Invoke-WebRequest $Url -OutFile speech.zip
Expand-Archive speech.zip
Set-Location "speech\speech-$Version-windows-x64\bin"
Set-ExecutionPolicy -Scope Process Bypass
.\speech_download_models.ps1
```

`Set-ExecutionPolicy -Scope Process Bypass` lets the unsigned
`speech_download_models.ps1` run in this shell only. `-Scope Process` does not
change the machine or user execution policy, and the relaxation ends when the
shell exits.

Then point Local CLI at the packaged Kokoro executable. Replace `C:\path\to`
with your extraction directory, and `0.0.11` with the `$Version` you downloaded:

```json5
{
  tts: {
    auto: "always",
    provider: "tts-local-cli",
    providers: {
      "tts-local-cli": {
        command: "C:\\path\\to\\speech-0.0.11-windows-x64\\bin\\speech_synthesize.exe",
        args: ["{{OutputPath}}", "{{Text}}", "en"],
        outputFormat: "wav",
        timeoutMs: 120000,
      },
    },
  },
}
```

See the [speech-core Windows CLI reference](https://github.com/soniqo/speech-core/blob/main/docs/cli.md)
for the packaged server, model cache, and standalone command syntax.

  </Tab>
</Tabs>

### Per-agent voice overrides

Use `agents.entries.*.tts` when one agent should speak with a different provider,
voice, model, persona, or auto-TTS mode. The agent block deep-merges over
`tts`, so provider credentials can stay in the global provider config:

```json5
{
  tts: {
    auto: "always",
    provider: "elevenlabs",
    providers: {
      elevenlabs: { apiKey: "${ELEVENLABS_API_KEY}", model: "eleven_multilingual_v2" },
    },
  },
  agents: {
    entries: {
      reader: {
        default: true,
        tts: {
          providers: {
            elevenlabs: { speakerVoiceId: "EXAVITQu4vr4xnSDxMaL" },
          },
        },
      },
    },
  },
}
```

To pin a per-agent persona, set `agents.entries.*.tts.persona` alongside provider
config — it overrides the global `tts.persona` for that agent only.

Precedence order for automatic replies, `/tts audio`, `/tts status`, and the
`tts` agent tool. Later layers win: each layer deep-merges over the ones above
it, so the last layer that sets a field decides its value.

1. `tts`
2. active `agents.entries.*.tts`
3. channel override, when the channel supports `channels.<channel>.tts`
4. account override, when the channel passes `channels.<channel>.accounts.<id>.tts`
5. local `/tts` preferences for this host
6. inline `[[tts:...]]` directives when [model overrides](/tools/tts/commands#model-driven-directives) are enabled

Channel and account overrides use the same shape as `tts` and
deep-merge over the earlier layers, so shared provider credentials can stay in
`tts` while a channel or bot account changes only speaker voice, model, persona,
or auto mode:

```json5
{
  tts: {
    provider: "openai",
    providers: {
      openai: { apiKey: "${OPENAI_API_KEY}", model: "gpt-4o-mini-tts" },
    },
  },
  channels: {
    feishu: {
      accounts: {
        english: {
          tts: {
            providers: {
              openai: { speakerVoice: "shimmer" },
            },
          },
        },
      },
    },
  },
}
```
