---
summary: "Hur inkommande ljud/röstmeddelanden laddas ned, transkriberas och injiceras i svar"
read_when:
  - Ändring av ljudtranskribering eller mediehantering
title: "Ljud och röstmeddelanden"
x-i18n:
  source_path: nodes/audio.md
  source_hash: b926c47989ab0d1e
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:17:46Z
---

# Ljud / röstmeddelanden — 2026-01-17

## Vad som fungerar

- **Medieförståelse (ljud)**: Om ljudförståelse är aktiverad (eller autodetekteras) gör OpenClaw:
  1. Lokaliserar den första ljudbilagan (lokal sökväg eller URL) och laddar ned den vid behov.
  2. Tillämpa `maxBytes` innan sändning till varje modellpost.
  3. Kör den första kvalificerade modellposten i ordning (leverantör eller CLI).
  4. Om den misslyckas eller hoppas över (storlek/timeout) prövas nästa post.
  5. Vid framgång ersätts `Body` med ett `[Audio]`-block och `{{Transcript}}` sätts.
- **Kommandotolkning**: När transkriberingen lyckas sätts `CommandBody`/`RawBody` till transkriptet så att snedstreckskommandon fortfarande fungerar.
- **Utförlig loggning**: I `--verbose` loggar vi när transkriberingen körs och när den ersätter brödtexten.

## Autodetektering (standard)

Om du **inte konfigurerar modeller** och `tools.media.audio.enabled` **inte** är satt till `false`,
autodetekterar OpenClaw i denna ordning och stannar vid första fungerande alternativ:

1. **Lokala CLI:er** (om installerade)
   - `sherpa-onnx-offline` (kräver `SHERPA_ONNX_MODEL_DIR` med encoder/decoder/joiner/tokens)
   - `whisper-cli` (från `whisper-cpp`; använder `WHISPER_CPP_MODEL` eller den medföljande tiny-modellen)
   - `whisper` (Python-CLI; laddar ned modeller automatiskt)
2. **Gemini CLI** (`gemini`) med `read_many_files`
3. **Leverantörsnycklar** (OpenAI → Groq → Deepgram → Google)

För att inaktivera autodetektering, sätt `tools.media.audio.enabled: false`.
För att anpassa, sätt `tools.media.audio.models`.
Obs: Detektering av binärer är best-effort över macOS/Linux/Windows; säkerställ att CLI:t finns på `PATH` (vi expanderar `~`), eller ange en explicit CLI-modell med full kommandosökväg.

## Konfigexempel

### Leverantör + CLI-fallback (OpenAI + Whisper CLI)

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

### Endast leverantör med scope-begränsning

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

### Endast leverantör (Deepgram)

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

## Noteringar & begränsningar

- Leverantörsautentisering följer standardordningen för modellautentisering (autentiseringsprofiler, miljövariabler, `models.providers.*.apiKey`).
- Deepgram plockar upp `DEEPGRAM_API_KEY` när `provider: "deepgram"` används.
- Detaljer för Deepgram-konfigurering: [Deepgram (ljudtranskribering)](/providers/deepgram).
- Ljudleverantörer kan åsidosätta `baseUrl`, `headers` och `providerOptions` via `tools.media.audio`.
- Standardstorleksgränsen är 20 MB (`tools.media.audio.maxBytes`). För stora ljud hoppas över för den modellen och nästa post prövas.
- Standard `maxChars` för ljud är **inte satt** (fullständigt transkript). Sätt `tools.media.audio.maxChars` eller per-post `maxChars` för att trimma utdata.
- OpenAI:s autostandard är `gpt-4o-mini-transcribe`; sätt `model: "gpt-4o-transcribe"` för högre noggrannhet.
- Använd `tools.media.audio.attachments` för att bearbeta flera röstmeddelanden (`mode: "all"` + `maxAttachments`).
- Transkriptet är tillgängligt för mallar som `{{Transcript}}`.
- CLI-stdout är begränsad (5 MB); håll CLI-utdata koncis.

## Fallgropar

- Scope-regler använder ”första träff vinner”. `chatType` normaliseras till `direct`, `group` eller `room`.
- Säkerställ att ditt CLI avslutar med 0 och skriver ren text; JSON behöver bearbetas via `jq -r .text`.
- Håll timeouts rimliga (`timeoutSeconds`, standard 60 s) för att undvika att blockera svarskön.
