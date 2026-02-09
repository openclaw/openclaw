---
summary: "Hvordan indgående lyd/voicenotes downloades, transskriberes og indsættes i svar"
read_when:
  - Ændring af lydtransskription eller mediehåndtering
title: "Lyd og Voicenotes"
---

# Lyd / Voicenotes — 2026-01-17

## Hvad virker

- **Medieforståelse (lyd)**: Hvis lydforståelse er aktiveret (eller auto‑detekteret), gør OpenClaw:
  1. Finder den første lydvedhæftning (lokal sti eller URL) og downloader den om nødvendigt.
  2. Håndhæver `maxBytes` før afsendelse til hver modelpost.
  3. Kører den første egnede modelpost i rækkefølge (udbyder eller CLI).
  4. Hvis den fejler eller springes over (størrelse/timeout), prøver den næste post.
  5. Ved succes erstatter den `Body` med en `[Audio]`‑blok og sætter `{{Transcript}}`.
- **Kommandofortolkning**: Når transskription lykkes, sættes `CommandBody`/`RawBody` til transskriptionen, så slash‑kommandoer stadig virker.
- **Udførlig logning**: I `--verbose` logger vi, når transskription kører, og når den erstatter brødteksten.

## Auto‑detektion (standard)

Hvis du **ikke konfigurerer modeller**, og `tools.media.audio.enabled` **ikke** er sat til `false`,
auto‑detekterer OpenClaw i denne rækkefølge og stopper ved den første fungerende mulighed:

1. **Lokale CLI’er** (hvis installeret)
   - `sherpa-onnx-offline` (kræver `SHERPA_ONNX_MODEL_DIR` med encoder/decoder/joiner/tokens)
   - `whisper-cli` (fra `whisper-cpp`; bruger `WHISPER_CPP_MODEL` eller den medfølgende tiny‑model)
   - `whisper` (Python CLI; downloader modeller automatisk)
2. **Gemini CLI** (`gemini`) med `read_many_files`
3. **Udbydernøgler** (OpenAI → Groq → Deepgram → Google)

For at deaktivere auto-detektion, angiv `tools.media.audio.enabled: false`.
For at tilpasse, angiv `tools.media.audio.models`.
Bemærk: Binær registrering er best-effort på tværs af macOS/Linux/Windows; sørg for, at CLI’en er på `PATH` (vi udvider `~`), eller angiv en eksplicit CLI-model med fuld kommandosti.

## Konfigurationseksempler

### Udbyder + CLI‑fallback (OpenAI + Whisper CLI)

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

### Kun udbyder med scope‑afgrænsning

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

### Kun udbyder (Deepgram)

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

## Noter & begrænsninger

- Udbyder‑autentificering følger den standardiserede rækkefølge for model‑autentificering (auth‑profiler, miljøvariabler, `models.providers.*.apiKey`).
- Deepgram opfanger `DEEPGRAM_API_KEY`, når `provider: "deepgram"` bruges.
- Deepgram‑opsætningsdetaljer: [Deepgram (lydtransskription)](/providers/deepgram).
- Lydudbydere kan tilsidesætte `baseUrl`, `headers` og `providerOptions` via `tools.media.audio`.
- Standard størrelse cap er 20MB (`tools.media.audio.maxBytes`). Oversize lyd er sprunget over for denne model og den næste post er prøvet.
- Standard `maxChars` for lyd er **unset** (full transcript). Indstil `tools.media.audio.maxChars` eller per-entry `maxChars` for at trimme output.
- OpenAI’s auto‑standard er `gpt-4o-mini-transcribe`; sæt `model: "gpt-4o-transcribe"` for højere nøjagtighed.
- Brug `tools.media.audio.attachments` til at behandle flere voicenotes (`mode: "all"` + `maxAttachments`).
- Transskriptionen er tilgængelig for skabeloner som `{{Transcript}}`.
- CLI‑stdout er begrænset (5MB); hold CLI‑output kortfattet.

## Faldgruber

- Anvendelsesregler bruger førsteklasses gevinster. `chatType` er normaliseret til `direct`, `group`, eller `room`.
- Sørg for, at din CLI afslutter med status 0 og udskriver ren tekst; JSON skal tilpasses via `jq -r .text`.
- Hold timeouts rimelige (`timeoutSeconds`, standard 60s) for at undgå at blokere svarkøen.
