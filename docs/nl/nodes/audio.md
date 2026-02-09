---
summary: "Hoe inkomende audio/spraaknotities worden gedownload, getranscribeerd en in antwoorden worden ingevoegd"
read_when:
  - Bij het wijzigen van audiotranscriptie of media-afhandeling
title: "Audio en spraaknotities"
---

# Audio / Spraaknotities — 2026-01-17

## Wat werkt

- **Mediaherkenning (audio)**: Als audioherkenning is ingeschakeld (of automatisch wordt gedetecteerd), doet OpenClaw het volgende:
  1. Vindt de eerste audio-bijlage (lokaal pad of URL) en downloadt deze indien nodig.
  2. Past `maxBytes` toe voordat naar elke modelvermelding wordt verzonden.
  3. Voert de eerste geschikte modelvermelding in volgorde uit (provider of CLI).
  4. Als dit faalt of wordt overgeslagen (grootte/time-out), wordt de volgende vermelding geprobeerd.
  5. Bij succes vervangt het `Body` door een `[Audio]`-blok en stelt `{{Transcript}}` in.
- **Command parsing**: Wanneer transcriptie slaagt, worden `CommandBody`/`RawBody` ingesteld op het transcript zodat slash-opdrachten blijven werken.
- **Uitgebreide logging**: In `--verbose` loggen we wanneer transcriptie draait en wanneer deze de body vervangt.

## Automatische detectie (standaard)

Als je **geen modellen configureert** en `tools.media.audio.enabled` **niet** is ingesteld op `false`,
detecteert OpenClaw automatisch in deze volgorde en stopt bij de eerste werkende optie:

1. **Lokale CLI’s** (indien geïnstalleerd)
   - `sherpa-onnx-offline` (vereist `SHERPA_ONNX_MODEL_DIR` met encoder/decoder/joiner/tokens)
   - `whisper-cli` (van `whisper-cpp`; gebruikt `WHISPER_CPP_MODEL` of het meegeleverde tiny-model)
   - `whisper` (Python-CLI; downloadt modellen automatisch)
2. **Gemini CLI** (`gemini`) met `read_many_files`
3. **Provider-sleutels** (OpenAI → Groq → Deepgram → Google)

Om automatische detectie uit te schakelen, stel `tools.media.audio.enabled: false` in.
Om te personaliseren, stel `tools.media.audio.models` in.
Let op: Detectie van binaries is best-effort op macOS/Linux/Windows; zorg dat de CLI op `PATH` staat (we breiden `~` uit), of stel een expliciet CLI-model in met een volledig opdrachtpad.

## Configuratievoorbeelden

### Provider + CLI-fallback (OpenAI + Whisper CLI)

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

### Alleen provider met scope-gating

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

### Alleen provider (Deepgram)

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

## Notities & limieten

- Provider-authenticatie volgt de standaard model-auth-volgorde (auth-profielen, omgevingsvariabelen, `models.providers.*.apiKey`).
- Deepgram pikt `DEEPGRAM_API_KEY` op wanneer `provider: "deepgram"` wordt gebruikt.
- Details voor Deepgram-installatie: [Deepgram (audiotranscriptie)](/providers/deepgram).
- Audioproviders kunnen `baseUrl`, `headers` en `providerOptions` overschrijven via `tools.media.audio`.
- De standaard maximale grootte is 20MB (`tools.media.audio.maxBytes`). Te grote audio wordt voor dat model overgeslagen en de volgende vermelding wordt geprobeerd.
- Standaard `maxChars` voor audio is **niet ingesteld** (volledig transcript). Stel `tools.media.audio.maxChars` in of per vermelding `maxChars` om de uitvoer in te korten.
- De OpenAI-standaard is `gpt-4o-mini-transcribe`; stel `model: "gpt-4o-transcribe"` in voor hogere nauwkeurigheid.
- Gebruik `tools.media.audio.attachments` om meerdere spraaknotities te verwerken (`mode: "all"` + `maxAttachments`).
- Het transcript is beschikbaar voor templates als `{{Transcript}}`.
- CLI-stdout is begrensd (5MB); houd CLI-uitvoer beknopt.

## Gotcha's

- Scoperegels gebruiken first-match-wins. `chatType` wordt genormaliseerd naar `direct`, `group` of `room`.
- Zorg dat je CLI met exitcode 0 afsluit en platte tekst print; JSON moet worden aangepast via `jq -r .text`.
- Houd time-outs redelijk (`timeoutSeconds`, standaard 60s) om blokkeren van de antwoordwachtrij te voorkomen.
