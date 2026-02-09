---
summary: "Inbound na pag‑unawa sa image/audio/video (opsyonal) gamit ang provider + CLI fallbacks"
read_when:
  - Pagdidisenyo o pagre‑refactor ng media understanding
  - Pag‑tune ng inbound audio/video/image preprocessing
title: "Media Understanding"
---

# Media Understanding (Inbound) — 2026-01-17

Maaaring **ibuod ng OpenClaw ang papasok na media** (image/audio/video) bago tumakbo ang reply pipeline. Awtomatiko nitong nade-detect kapag available ang mga lokal na tool o provider key, at maaaring i-disable o i-customize. Kung hindi maayos ang pag-unawa, tatanggap pa rin ang mga modelo ng mga orihinal na file/URL gaya ng dati.

## Mga layunin

- Opsyonal: i‑pre‑digest ang inbound media tungo sa maikling text para sa mas mabilis na routing at mas mahusay na command parsing.
- Panatilihin ang paghahatid ng orihinal na media sa model (palagi).
- Suportahan ang **provider APIs** at **CLI fallbacks**.
- Payagan ang maraming model na may nakaayos na fallback (error/size/timeout).

## High‑level na pag‑uugali

1. Kolektahin ang inbound attachments (`MediaPaths`, `MediaUrls`, `MediaTypes`).
2. Para sa bawat naka‑enable na capability (image/audio/video), pumili ng attachments ayon sa policy (default: **una**).
3. Piliin ang unang eligible na model entry (size + capability + auth).
4. Kapag pumalya ang isang model o masyadong malaki ang media, **mag‑fall back sa susunod na entry**.
5. Kapag nagtagumpay:
   - Ang `Body` ay nagiging `[Image]`, `[Audio]`, o `[Video]` block.
   - Ang audio ay nagse‑set ng `{{Transcript}}`; ginagamit ng command parsing ang caption text kapag mayroon,
     kung wala, ang transcript.
   - Ang mga caption ay pinapanatili bilang `User text:` sa loob ng block.

Kapag pumalya ang understanding o naka‑disable ito, **magpapatuloy ang reply flow** gamit ang orihinal na body + attachments.

## Pangkalahatang‑ideya ng config

Sinusuportahan ng `tools.media` ang **shared models** kasama ang mga override kada capability:

- `tools.media.models`: shared model list (gamitin ang `capabilities` para mag‑gate).
- `tools.media.image` / `tools.media.audio` / `tools.media.video`:
  - mga default (`prompt`, `maxChars`, `maxBytes`, `timeoutSeconds`, `language`)
  - provider overrides (`baseUrl`, `headers`, `providerOptions`)
  - mga opsyon ng Deepgram audio sa pamamagitan ng `tools.media.audio.providerOptions.deepgram`
  - opsyonal na **per‑capability `models` list** (inuuna bago ang shared models)
  - `attachments` policy (`mode`, `maxAttachments`, `prefer`)
  - `scope` (opsyonal na gating ayon sa channel/chatType/session key)
- `tools.media.concurrency`: max na sabayang capability runs (default **2**).

```json5
{
  tools: {
    media: {
      models: [
        /* shared list */
      ],
      image: {
        /* optional overrides */
      },
      audio: {
        /* optional overrides */
      },
      video: {
        /* optional overrides */
      },
    },
  },
}
```

### Mga model entry

Ang bawat `models[]` entry ay maaaring **provider** o **CLI**:

```json5
{
  type: "provider", // default if omitted
  provider: "openai",
  model: "gpt-5.2",
  prompt: "Describe the image in <= 500 chars.",
  maxChars: 500,
  maxBytes: 10485760,
  timeoutSeconds: 60,
  capabilities: ["image"], // optional, used for multi‑modal entries
  profile: "vision-profile",
  preferredProfile: "vision-fallback",
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
    "Read the media at {{MediaPath}} and describe it in <= {{MaxChars}} characters.",
  ],
  maxChars: 500,
  maxBytes: 52428800,
  timeoutSeconds: 120,
  capabilities: ["video", "image"],
}
```

Maaari ring gumamit ang mga CLI template ng:

- `{{MediaDir}}` (directory na naglalaman ng media file)
- `{{OutputDir}}` (scratch dir na nilikha para sa run na ito)
- `{{OutputBase}}` (base path ng scratch file, walang extension)

## Mga default at limitasyon

Inirerekomendang mga default:

- `maxChars`: **500** para sa image/video (maikli, command‑friendly)
- `maxChars`: **unset** para sa audio (buong transcript maliban kung mag‑set ka ng limit)
- `maxBytes`:
  - image: **10MB**
  - audio: **20MB**
  - video: **50MB**

Mga panuntunan:

- Kapag lumampas ang media sa `maxBytes`, nilalaktawan ang model na iyon at **sinusubukan ang susunod**.
- Kapag nagbalik ang model ng higit sa `maxChars`, pinuputol ang output.
- Ang `prompt` ay default sa simpleng “Describe the {media}.” kasama ang gabay na `maxChars` (image/video lamang).
- Kapag `<capability>.enabled: true` ngunit walang naka‑configure na mga model, sinusubukan ng OpenClaw ang
  **aktibong reply model** kapag sinusuportahan ng provider nito ang capability.

### Auto‑detect ng media understanding (default)

If `tools.media.<capability>.enabled` is **not** set to `false` and you haven’t
configured models, OpenClaw auto-detects in this order and **stops at the first
working option**:

1. **Local CLIs** (audio lamang; kung naka‑install)
   - `sherpa-onnx-offline` (nangangailangan ng `SHERPA_ONNX_MODEL_DIR` na may encoder/decoder/joiner/tokens)
   - `whisper-cli` (`whisper-cpp`; gumagamit ng `WHISPER_CPP_MODEL` o ng bundled tiny model)
   - `whisper` (Python CLI; awtomatikong nagda‑download ng mga model)
2. **Gemini CLI** (`gemini`) gamit ang `read_many_files`
3. **Provider keys**
   - Audio: OpenAI → Groq → Deepgram → Google
   - Image: OpenAI → Anthropic → Google → MiniMax
   - Video: Google

Para i‑disable ang auto‑detection, itakda ang:

```json5
{
  tools: {
    media: {
      audio: {
        enabled: false,
      },
    },
  },
}
```

Tala: Best‑effort ang binary detection sa macOS/Linux/Windows; tiyaking nasa `PATH` ang CLI (ini‑expand namin ang `~`), o mag‑set ng explicit na CLI model na may buong command path.

## Mga capability (opsyonal)

If you set `capabilities`, the entry only runs for those media types. Para sa mga shared
listahan, maaaring maghinuha ang OpenClaw ng mga default:

- `openai`, `anthropic`, `minimax`: **image**
- `google` (Gemini API): **image + audio + video**
- `groq`: **audio**
- `deepgram`: **audio**

Para sa mga CLI entry, **itakda ang `capabilities` nang tahasan** upang maiwasan ang nakakagulat na mga tugma.
Kung aalisin mo ang `capabilities`, ang entry ay eligible para sa listahang kinabibilangan nito.

## Provider support matrix (mga integrasyon ng OpenClaw)

| Capability | Integrasyon ng provider                                        | Mga tala                                                                             |
| ---------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Image      | OpenAI / Anthropic / Google / iba pa sa pamamagitan ng `pi-ai` | Gumagana ang anumang image‑capable na model sa registry.             |
| Audio      | OpenAI, Groq, Deepgram, Google                                 | Provider transcription (Whisper/Deepgram/Gemini). |
| Video      | Google (Gemini API)                         | Provider video understanding.                                        |

## Mga inirerekomendang provider

**Image**

- Mas mainam ang aktibong model mo kung sinusuportahan nito ang images.
- Magagandang default: `openai/gpt-5.2`, `anthropic/claude-opus-4-6`, `google/gemini-3-pro-preview`.

**Audio**

- `openai/gpt-4o-mini-transcribe`, `groq/whisper-large-v3-turbo`, o `deepgram/nova-3`.
- CLI fallback: `whisper-cli` (whisper-cpp) o `whisper`.
- Setup ng Deepgram: [Deepgram (audio transcription)](/providers/deepgram).

**Video**

- `google/gemini-3-flash-preview` (mabilis), `google/gemini-3-pro-preview` (mas mayaman).
- CLI fallback: `gemini` CLI (sumusuporta sa `read_file` sa video/audio).

## Attachment policy

Kinokontrol ng per‑capability `attachments` kung aling attachments ang ipoproseso:

- `mode`: `first` (default) o `all`
- `maxAttachments`: limitahan ang bilang na ipoproseso (default **1**)
- `prefer`: `first`, `last`, `path`, `url`

Kapag `mode: "all"`, nilalabelan ang mga output bilang `[Image 1/2]`, `[Audio 2/2]`, atbp.

## Mga halimbawa ng config

### 1. Shared models list + overrides

```json5
{
  tools: {
    media: {
      models: [
        { provider: "openai", model: "gpt-5.2", capabilities: ["image"] },
        {
          provider: "google",
          model: "gemini-3-flash-preview",
          capabilities: ["image", "audio", "video"],
        },
        {
          type: "cli",
          command: "gemini",
          args: [
            "-m",
            "gemini-3-flash",
            "--allowed-tools",
            "read_file",
            "Read the media at {{MediaPath}} and describe it in <= {{MaxChars}} characters.",
          ],
          capabilities: ["image", "video"],
        },
      ],
      audio: {
        attachments: { mode: "all", maxAttachments: 2 },
      },
      video: {
        maxChars: 500,
      },
    },
  },
}
```

### 2. Audio + Video lamang (image off)

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [
          { provider: "openai", model: "gpt-4o-mini-transcribe" },
          {
            type: "cli",
            command: "whisper",
            args: ["--model", "base", "{{MediaPath}}"],
          },
        ],
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
              "Read the media at {{MediaPath}} and describe it in <= {{MaxChars}} characters.",
            ],
          },
        ],
      },
    },
  },
}
```

### 3. Opsyonal na image understanding

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
          { provider: "anthropic", model: "claude-opus-4-6" },
          {
            type: "cli",
            command: "gemini",
            args: [
              "-m",
              "gemini-3-flash",
              "--allowed-tools",
              "read_file",
              "Read the media at {{MediaPath}} and describe it in <= {{MaxChars}} characters.",
            ],
          },
        ],
      },
    },
  },
}
```

### 4. Multi‑modal na iisang entry (explicit capabilities)

```json5
{
  tools: {
    media: {
      image: {
        models: [
          {
            provider: "google",
            model: "gemini-3-pro-preview",
            capabilities: ["image", "video", "audio"],
          },
        ],
      },
      audio: {
        models: [
          {
            provider: "google",
            model: "gemini-3-pro-preview",
            capabilities: ["image", "video", "audio"],
          },
        ],
      },
      video: {
        models: [
          {
            provider: "google",
            model: "gemini-3-pro-preview",
            capabilities: ["image", "video", "audio"],
          },
        ],
      },
    },
  },
}
```

## Status output

Kapag tumakbo ang media understanding, may kasamang maikling summary line ang `/status`:

```
📎 Media: image ok (openai/gpt-5.2) · audio skipped (maxBytes)
```

Ipinapakita nito ang kinalabasan kada capability at ang napiling provider/model kapag naaangkop.

## Mga tala

- Ang understanding ay **best‑effort**. Hindi hinaharangan ng mga error ang mga reply.
- Ipinapasa pa rin ang mga attachment sa mga model kahit naka‑disable ang understanding.
- Gamitin ang `scope` para limitahan kung saan tumatakbo ang understanding (hal. mga DM lamang).

## Kaugnay na docs

- [Configuration](/gateway/configuration)
- [Image & Media Support](/nodes/images)
