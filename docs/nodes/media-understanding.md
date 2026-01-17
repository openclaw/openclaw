---
summary: "Inbound image/audio/video understanding (optional) with provider + CLI fallbacks"
read_when:
  - Designing or refactoring media understanding
  - Tuning inbound audio/video/image preprocessing
---
# Media Understanding (Inbound) — 2026-01-17

Clawdbot can optionally **summarize inbound media** (image/audio/video) before the reply pipeline runs. This is **opt-in** and separate from the base attachment flow—if understanding is off, models still receive the original files/URLs as usual.

## Goals
- Optional: pre‑digest inbound media into short text for faster routing + better command parsing.
- Preserve original media delivery to the model (always).
- Support **provider APIs** and **CLI fallbacks**.
- Allow multiple models with ordered fallback (error/size/timeout).

## High‑level behavior
1) Collect inbound attachments (`MediaPaths`, `MediaUrls`, `MediaTypes`).
2) For each enabled capability (image/audio/video), pick the **first matching attachment**.
3) Choose the first eligible model entry (size + capability + auth).  
4) If a model fails or the media is too large, **fall back to the next entry**.
5) On success:
   - `Body` becomes `[Image]`, `[Audio]`, or `[Video]` block.
   - Audio sets `{{Transcript}}` and `CommandBody`/`RawBody` for command parsing.
   - Captions are preserved as `User text:` inside the block.

If understanding fails or is disabled, **the reply flow continues** with the original body + attachments.

## Config overview
Use **per‑capability configs** under `tools.media`. Each capability can define:
- defaults (`prompt`, `maxChars`, `maxBytes`, `timeoutSeconds`, `language`)
- **ordered `models` list** (fallback order)
- `scope` (optional gating by channel/chatType/session key)

```json5
{
  tools: {
    media: {
      image: { /* config */ },
      audio: { /* config */ },
      video: { /* config */ }
    }
  }
}
```

### Model entries
Each `models[]` entry can be **provider** or **CLI**:

```json5
{
  type: "provider",        // default if omitted
  provider: "openai",
  model: "gpt-5.2",
  prompt: "Describe the image in <= 500 chars.",
  maxChars: 500,
  maxBytes: 10485760,
  timeoutSeconds: 60,
  capabilities: ["image"], // optional, used for multi‑modal entries
  profile: "vision-profile",
  preferredProfile: "vision-fallback"
}
```

```json5
{
  type: "cli",
  command: "gemini",
  args: [
    "-m",
    "gemini-3-flash",
    "--allowed-tools",
    "read_file",
    "Read the media at {{MediaPath}} and describe it in <= {{MaxChars}} characters."
  ],
  maxChars: 500,
  maxBytes: 52428800,
  timeoutSeconds: 120,
  capabilities: ["video", "image"]
}
```

## Defaults and limits
Recommended defaults:
- `maxChars`: **500** for image/video (short, command‑friendly)
- `maxChars`: **unset** for audio (full transcript unless you set a limit)
- `maxBytes`:
  - image: **10MB**
  - audio: **20MB**
  - video: **50MB**

Rules:
- If media exceeds `maxBytes`, that model is skipped and the **next model is tried**.
- If the model returns more than `maxChars`, output is trimmed.
- `prompt` defaults to simple “Describe the {media}.” plus the `maxChars` guidance (image/video only).

## Capabilities (optional)
If you set `capabilities`, the entry only runs for those media types. Suggested
defaults when you opt in:
- `openai`, `anthropic`: **image**
- `google` (Gemini API): **image + audio + video**
- CLI entries: declare the exact capabilities you support.

If you omit `capabilities`, the entry is eligible for the list it appears in.

## Provider support matrix (Clawdbot integrations)
| Capability | Provider integration | Notes |
|------------|----------------------|-------|
| Image | OpenAI / Anthropic / Google / others via `pi-ai` | Any image-capable model in the registry works. |
| Audio | OpenAI, Groq | Provider transcription (Whisper). |
| Video | Google (Gemini API) | Provider video understanding. |

## Recommended providers
**Image**
- Prefer your active model if it supports images.
- Good defaults: `openai/gpt-5.2`, `anthropic/claude-opus-4-5`, `google/gemini-3-pro-preview`.

**Audio**
- `openai/whisper-1` or `groq/whisper-large-v3-turbo`.
- CLI fallback: `whisper` binary.

**Video**
- `google/gemini-3-flash-preview` (fast), `google/gemini-3-pro-preview` (richer).
- CLI fallback: `gemini` CLI (supports `read_file` on video/audio).

## Config examples

### 1) Audio + Video only (image off)
```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [
          { provider: "openai", model: "whisper-1" },
          {
            type: "cli",
            command: "whisper",
            args: ["--model", "base", "{{MediaPath}}"]
          }
        ]
      },
      video: {
        enabled: true,
        maxChars: 500,
        models: [
          { provider: "google", model: "gemini-3-flash-preview" },
          {
            type: "cli",
            command: "gemini",
            args: [
              "-m",
              "gemini-3-flash",
              "--allowed-tools",
              "read_file",
              "Read the media at {{MediaPath}} and describe it in <= {{MaxChars}} characters."
            ]
          }
        ]
      }
    }
  }
}
```

### 2) Optional image understanding
```json5
{
  tools: {
    media: {
      image: {
        enabled: true,
        maxBytes: 10485760,
        maxChars: 500,
        models: [
          { provider: "openai", model: "gpt-5.2" },
          { provider: "anthropic", model: "claude-opus-4-5" },
          {
            type: "cli",
            command: "gemini",
            args: [
              "-m",
              "gemini-3-flash",
              "--allowed-tools",
              "read_file",
              "Read the media at {{MediaPath}} and describe it in <= {{MaxChars}} characters."
            ]
          }
        ]
      }
    }
  }
}
```

### 3) Multi‑modal single entry (explicit capabilities)
```json5
{
  tools: {
    media: {
      image: { models: [{ provider: "google", model: "gemini-3-pro-preview", capabilities: ["image", "video", "audio"] }] },
      audio: { models: [{ provider: "google", model: "gemini-3-pro-preview", capabilities: ["image", "video", "audio"] }] },
      video: { models: [{ provider: "google", model: "gemini-3-pro-preview", capabilities: ["image", "video", "audio"] }] }
    }
  }
}
```

## Notes
- Understanding is **best‑effort**. Errors do not block replies.
- Attachments are still passed to models even when understanding is disabled.
- Use `scope` to limit where understanding runs (e.g. only DMs).

## Related docs
- [Configuration](/gateway/configuration)
- [Image & Media Support](/nodes/images)
