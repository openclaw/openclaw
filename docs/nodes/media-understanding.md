---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Inbound image/audio/video understanding (optional) with provider + CLI fallbacks"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Designing or refactoring media understanding（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Tuning inbound audio/video/image preprocessing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Media Understanding"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Media Understanding (Inbound) — 2026-01-17（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw can **summarize inbound media** (image/audio/video) before the reply pipeline runs. It auto‑detects when local tools or provider keys are available, and can be disabled or customized. If understanding is off, models still receive the original files/URLs as usual.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Goals（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Optional: pre‑digest inbound media into short text for faster routing + better command parsing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Preserve original media delivery to the model (always).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Support **provider APIs** and **CLI fallbacks**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Allow multiple models with ordered fallback (error/size/timeout).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## High‑level behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Collect inbound attachments (`MediaPaths`, `MediaUrls`, `MediaTypes`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. For each enabled capability (image/audio/video), select attachments per policy (default: **first**).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Choose the first eligible model entry (size + capability + auth).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. If a model fails or the media is too large, **fall back to the next entry**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. On success:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `Body` becomes `[Image]`, `[Audio]`, or `[Video]` block.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Audio sets `{{Transcript}}`; command parsing uses caption text when present,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     otherwise the transcript.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Captions are preserved as `User text:` inside the block.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If understanding fails or is disabled, **the reply flow continues** with the original body + attachments.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Config overview（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`tools.media` supports **shared models** plus per‑capability overrides:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.media.models`: shared model list (use `capabilities` to gate).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.media.image` / `tools.media.audio` / `tools.media.video`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - defaults (`prompt`, `maxChars`, `maxBytes`, `timeoutSeconds`, `language`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - provider overrides (`baseUrl`, `headers`, `providerOptions`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Deepgram audio options via `tools.media.audio.providerOptions.deepgram`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - optional **per‑capability `models` list** (preferred before shared models)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `attachments` policy (`mode`, `maxAttachments`, `prefer`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `scope` (optional gating by channel/chatType/session key)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.media.concurrency`: max concurrent capability runs (default **2**).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    media: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      models: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        /* shared list */（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      image: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        /* optional overrides */（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      audio: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        /* optional overrides */（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      video: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        /* optional overrides */（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Model entries（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Each `models[]` entry can be **provider** or **CLI**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  type: "provider", // default if omitted（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  provider: "openai",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: "gpt-5.2",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Describe the image in <= 500 chars.",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  maxChars: 500,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  maxBytes: 10485760,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  timeoutSeconds: 60,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  capabilities: ["image"], // optional, used for multi‑modal entries（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  profile: "vision-profile",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  preferredProfile: "vision-fallback",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  type: "cli",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  command: "gemini",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  args: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "-m",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "gemini-3-flash",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "--allowed-tools",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "read_file",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "Read the media at {{MediaPath}} and describe it in <= {{MaxChars}} characters.",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  maxChars: 500,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  maxBytes: 52428800,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  timeoutSeconds: 120,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  capabilities: ["video", "image"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CLI templates can also use:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `{{MediaDir}}` (directory containing the media file)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `{{OutputDir}}` (scratch dir created for this run)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `{{OutputBase}}` (scratch file base path, no extension)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Defaults and limits（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Recommended defaults:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `maxChars`: **500** for image/video (short, command‑friendly)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `maxChars`: **unset** for audio (full transcript unless you set a limit)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `maxBytes`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - image: **10MB**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - audio: **20MB**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - video: **50MB**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Rules:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If media exceeds `maxBytes`, that model is skipped and the **next model is tried**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If the model returns more than `maxChars`, output is trimmed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `prompt` defaults to simple “Describe the {media}.” plus the `maxChars` guidance (image/video only).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If `<capability>.enabled: true` but no models are configured, OpenClaw tries the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  **active reply model** when its provider supports the capability.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Auto-detect media understanding (default)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If `tools.media.<capability>.enabled` is **not** set to `false` and you haven’t（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
configured models, OpenClaw auto-detects in this order and **stops at the first（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
working option**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Local CLIs** (audio only; if installed)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `sherpa-onnx-offline` (requires `SHERPA_ONNX_MODEL_DIR` with encoder/decoder/joiner/tokens)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `whisper-cli` (`whisper-cpp`; uses `WHISPER_CPP_MODEL` or the bundled tiny model)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `whisper` (Python CLI; downloads models automatically)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Gemini CLI** (`gemini`) using `read_many_files`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Provider keys**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Audio: OpenAI → Groq → Deepgram → Google（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Image: OpenAI → Anthropic → Google → MiniMax（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Video: Google（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To disable auto-detection, set:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    media: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      audio: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        enabled: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Note: Binary detection is best-effort across macOS/Linux/Windows; ensure the CLI is on `PATH` (we expand `~`), or set an explicit CLI model with a full command path.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Capabilities (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you set `capabilities`, the entry only runs for those media types. For shared（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
lists, OpenClaw can infer defaults:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openai`, `anthropic`, `minimax`: **image**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `google` (Gemini API): **image + audio + video**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `groq`: **audio**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `deepgram`: **audio**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For CLI entries, **set `capabilities` explicitly** to avoid surprising matches.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you omit `capabilities`, the entry is eligible for the list it appears in.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Provider support matrix (OpenClaw integrations)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Capability | Provider integration                             | Notes                                             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------- | ------------------------------------------------ | ------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Image      | OpenAI / Anthropic / Google / others via `pi-ai` | Any image-capable model in the registry works.    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Audio      | OpenAI, Groq, Deepgram, Google                   | Provider transcription (Whisper/Deepgram/Gemini). |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Video      | Google (Gemini API)                              | Provider video understanding.                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Recommended providers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Image**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Prefer your active model if it supports images.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Good defaults: `openai/gpt-5.2`, `anthropic/claude-opus-4-6`, `google/gemini-3-pro-preview`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Audio**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openai/gpt-4o-mini-transcribe`, `groq/whisper-large-v3-turbo`, or `deepgram/nova-3`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI fallback: `whisper-cli` (whisper-cpp) or `whisper`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Deepgram setup: [Deepgram (audio transcription)](/providers/deepgram).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Video**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `google/gemini-3-flash-preview` (fast), `google/gemini-3-pro-preview` (richer).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI fallback: `gemini` CLI (supports `read_file` on video/audio).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Attachment policy（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Per‑capability `attachments` controls which attachments are processed:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `mode`: `first` (default) or `all`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `maxAttachments`: cap the number processed (default **1**)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `prefer`: `first`, `last`, `path`, `url`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When `mode: "all"`, outputs are labeled `[Image 1/2]`, `[Audio 2/2]`, etc.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Config examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 1) Shared models list + overrides（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    media: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      models: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        { provider: "openai", model: "gpt-5.2", capabilities: ["image"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          provider: "google",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          model: "gemini-3-flash-preview",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          capabilities: ["image", "audio", "video"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          type: "cli",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          command: "gemini",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          args: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "-m",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "gemini-3-flash",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "--allowed-tools",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "read_file",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "Read the media at {{MediaPath}} and describe it in <= {{MaxChars}} characters.",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          capabilities: ["image", "video"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      audio: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        attachments: { mode: "all", maxAttachments: 2 },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      video: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        maxChars: 500,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 2) Audio + Video only (image off)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    media: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      audio: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        models: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          { provider: "openai", model: "gpt-4o-mini-transcribe" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            type: "cli",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            command: "whisper",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            args: ["--model", "base", "{{MediaPath}}"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      video: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        maxChars: 500,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        models: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          { provider: "google", model: "gemini-3-flash-preview" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            type: "cli",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            command: "gemini",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            args: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "-m",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "gemini-3-flash",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "--allowed-tools",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "read_file",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "Read the media at {{MediaPath}} and describe it in <= {{MaxChars}} characters.",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 3) Optional image understanding（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    media: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      image: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        maxBytes: 10485760,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        maxChars: 500,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        models: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          { provider: "openai", model: "gpt-5.2" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          { provider: "anthropic", model: "claude-opus-4-6" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            type: "cli",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            command: "gemini",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            args: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "-m",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "gemini-3-flash",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "--allowed-tools",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "read_file",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "Read the media at {{MediaPath}} and describe it in <= {{MaxChars}} characters.",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 4) Multi‑modal single entry (explicit capabilities)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    media: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      image: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        models: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            provider: "google",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            model: "gemini-3-pro-preview",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            capabilities: ["image", "video", "audio"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      audio: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        models: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            provider: "google",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            model: "gemini-3-pro-preview",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            capabilities: ["image", "video", "audio"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      video: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        models: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            provider: "google",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            model: "gemini-3-pro-preview",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            capabilities: ["image", "video", "audio"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Status output（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When media understanding runs, `/status` includes a short summary line:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
📎 Media: image ok (openai/gpt-5.2) · audio skipped (maxBytes)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This shows per‑capability outcomes and the chosen provider/model when applicable.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Understanding is **best‑effort**. Errors do not block replies.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Attachments are still passed to models even when understanding is disabled.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `scope` to limit where understanding runs (e.g. only DMs).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Related docs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Configuration](/gateway/configuration)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Image & Media Support](/nodes/images)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
