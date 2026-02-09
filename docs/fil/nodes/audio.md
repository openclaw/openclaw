---
summary: "Paano dina-download, tina-transcribe, at ini-inject sa mga sagot ang papasok na audio/voice notes"
read_when:
  - Binabago ang audio transcription o paghawak ng media
title: "Audio at Voice Notes"
---

# Audio / Voice Notes — 2026-01-17

## Ano ang gumagana

- **Pag-unawa sa media (audio)**: Kapag naka-enable (o auto‑detected) ang audio understanding, ang OpenClaw ay:
  1. Hinahanap ang unang audio attachment (local path o URL) at dina-download ito kung kinakailangan.
  2. Ipinapatupad ang `maxBytes` bago ipadala sa bawat model entry.
  3. Pinapatakbo ang unang kwalipikadong model entry ayon sa pagkakasunod (provider o CLI).
  4. Kapag pumalya o na-skip (size/timeout), sinusubukan ang susunod na entry.
  5. Kapag matagumpay, pinapalitan nito ang `Body` ng isang `[Audio]` block at itinatakda ang `{{Transcript}}`.
- **Pag-parse ng command**: Kapag matagumpay ang transcription, itinatakda ang `CommandBody`/`RawBody` sa transcript para gumana pa rin ang mga slash command.
- **Detalyadong logging**: Sa `--verbose`, nagla-log kami kung kailan tumatakbo ang transcription at kung kailan nito pinapalitan ang body.

## Auto-detection (default)

Kung **hindi ka nagko-configure ng mga model** at ang `tools.media.audio.enabled` ay **hindi** nakatakda sa `false`,
ina-auto-detect ng OpenClaw sa ganitong pagkakasunod at humihinto sa unang gumaganang opsyon:

1. **Mga lokal na CLI** (kung naka-install)
   - `sherpa-onnx-offline` (nangangailangan ng `SHERPA_ONNX_MODEL_DIR` na may encoder/decoder/joiner/tokens)
   - `whisper-cli` (mula sa `whisper-cpp`; gumagamit ng `WHISPER_CPP_MODEL` o ng bundled tiny model)
   - `whisper` (Python CLI; awtomatikong nagda-download ng mga model)
2. **Gemini CLI** (`gemini`) gamit ang `read_many_files`
3. **Mga provider key** (OpenAI → Groq → Deepgram → Google)

Upang i-disable ang auto-detection, itakda ang `tools.media.audio.enabled: false`.
To customize, set `tools.media.audio.models`.
Tala: Best‑effort ang binary detection sa macOS/Linux/Windows; tiyaking nasa `PATH` ang CLI (ini‑expand namin ang `~`), o mag‑set ng explicit na CLI model na may buong command path.

## Mga halimbawa ng config

### Provider + CLI fallback (OpenAI + Whisper CLI)

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        maxBytes: 20971520,
        models: [
          { provider: "openai", model: "gpt-4o-mini-transcribe" },
          {
            type: "cli",
            command: "whisper",
            args: ["--model", "base", "{{MediaPath}}"],
            timeoutSeconds: 45,
          },
        ],
      },
    },
  },
}
```

### Provider-only na may scope gating

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        scope: {
          default: "allow",
          rules: [{ action: "deny", match: { chatType: "group" } }],
        },
        models: [{ provider: "openai", model: "gpt-4o-mini-transcribe" }],
      },
    },
  },
}
```

### Provider-only (Deepgram)

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "deepgram", model: "nova-3" }],
      },
    },
  },
}
```

## Mga tala at limitasyon

- Ang provider auth ay sumusunod sa karaniwang pagkakasunod ng model auth (auth profiles, mga environment variable, `models.providers.*.apiKey`).
- Kinukuha ng Deepgram ang `DEEPGRAM_API_KEY` kapag ginamit ang `provider: "deepgram"`.
- Mga detalye ng setup ng Deepgram: [Deepgram (audio transcription)](/providers/deepgram).
- Maaaring i-override ng mga audio provider ang `baseUrl`, `headers`, at `providerOptions` sa pamamagitan ng `tools.media.audio`.
- Default size cap is 20MB (`tools.media.audio.maxBytes`). Ang sobrang laki ng audio ay nilalaktawan para sa modelong iyon at susubukan ang susunod na entry.
- Default `maxChars` for audio is **unset** (full transcript). Itakda ang `tools.media.audio.maxChars` o ang per-entry na `maxChars` upang bawasan ang output.
- Ang OpenAI auto default ay `gpt-4o-mini-transcribe`; itakda ang `model: "gpt-4o-transcribe"` para sa mas mataas na accuracy.
- Gamitin ang `tools.media.audio.attachments` para iproseso ang maraming voice note (`mode: "all"` + `maxAttachments`).
- Available ang transcript sa mga template bilang `{{Transcript}}`.
- May cap ang CLI stdout (5MB); panatilihing maikli ang output ng CLI.

## Mga dapat bantayan

- Scope rules use first-match wins. `chatType` is normalized to `direct`, `group`, or `room`.
- Tiyaking nag-e-exit ang iyong CLI na may 0 at nagpi-print ng plain text; ang JSON ay kailangang ayusin sa pamamagitan ng `jq -r .text`.
- Panatilihing makatwiran ang mga timeout (`timeoutSeconds`, default 60s) para maiwasang ma-block ang reply queue.
