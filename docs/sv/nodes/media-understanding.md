---
summary: "Inkommande bild-/ljud-/videoförståelse (valfritt) med leverantör + CLI‑fallbacks"
read_when:
  - Utformning eller omarbetning av medieförståelse
  - Justering av förbehandling av inkommande ljud/video/bild
title: "Medieförståelse"
---

# Medieförståelse (inkommande) — 2026-01-17

OpenClaw kan **sammanfatta inkommande media** (bild/ljud/video) innan svarsledningen körs. Det detekterar automatiskt när lokala verktyg eller leverantörsnycklar är tillgängliga, och kan inaktiveras eller anpassas. Om förståelsen är avstängd får modellerna fortfarande de ursprungliga filerna/webbadresserna som vanligt.

## Mål

- Valfritt: förbearbeta inkommande media till kort text för snabbare routning + bättre kommandotolkning.
- Bevara leverans av originalmedia till modellen (alltid).
- Stöd för **leverantörs‑API:er** och **CLI‑fallbacks**.
- Tillåt flera modeller med ordnad fallback (fel/storlek/timeout).

## Beteende på hög nivå

1. Samla inkommande bilagor (`MediaPaths`, `MediaUrls`, `MediaTypes`).
2. För varje aktiverad kapacitet (bild/ljud/video), välj bilagor enligt policy (standard: **första**).
3. Välj den första kvalificerade modellposten (storlek + kapacitet + autentisering).
4. Om en modell misslyckas eller mediet är för stort, **fall tillbaka till nästa post**.
5. Vid lyckat resultat:
   - `Body` blir ett `[Image]`, `[Audio]` eller `[Video]`‑block.
   - Ljud sätter `{{Transcript}}`; kommandotolkning använder bildtext när sådan finns,
     annars transkriptet.
   - Bildtexter bevaras som `User text:` inuti blocket.

Om förståelse misslyckas eller är inaktiverad **fortsätter svarsflödet** med originalkropp + bilagor.

## Konfigöversikt

`tools.media` stöder **delade modeller** plus åsidosättningar per kapacitet:

- `tools.media.models`: lista med delade modeller (använd `capabilities` för gating).
- `tools.media.image` / `tools.media.audio` / `tools.media.video`:
  - standardvärden (`prompt`, `maxChars`, `maxBytes`, `timeoutSeconds`, `language`)
  - leverantörs‑åsidosättningar (`baseUrl`, `headers`, `providerOptions`)
  - Deepgram‑ljudalternativ via `tools.media.audio.providerOptions.deepgram`
  - valfri **per‑kapacitet `models`‑lista** (föredras före delade modeller)
  - `attachments`‑policy (`mode`, `maxAttachments`, `prefer`)
  - `scope` (valfri gating per kanal/chatType/session‑nyckel)
- `tools.media.concurrency`: max antal samtidiga körningar per kapacitet (standard **2**).

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

### Modellposter

Varje `models[]`‑post kan vara **leverantör** eller **CLI**:

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

CLI‑mallar kan även använda:

- `{{MediaDir}}` (katalog som innehåller mediefilen)
- `{{OutputDir}}` (arbetskatalog skapad för denna körning)
- `{{OutputBase}}` (bas­sökväg för arbetsfil, utan filändelse)

## Standardvärden och gränser

Rekommenderade standarder:

- `maxChars`: **500** för bild/video (kort, kommandovänligt)
- `maxChars`: **inte satt** för ljud (fullständigt transkript om du inte sätter en gräns)
- `maxBytes`:
  - bild: **10MB**
  - ljud: **20MB**
  - video: **50MB**

Regler:

- Om media överskrider `maxBytes` hoppas den modellen över och **nästa modell prövas**.
- Om modellen returnerar mer än `maxChars` trimmas utdata.
- `prompt` är som standard en enkel ”Describe the {media}.” plus `maxChars`‑vägledningen (endast bild/video).
- Om `<capability>.enabled: true` men inga modeller är konfigurerade försöker OpenClaw använda
  **den aktiva svarsmodellen** när dess leverantör stöder kapaciteten.

### Automatisk identifiering av medieförståelse (standard)

Om `tools.media.<capability>.enabled` är **inte** satt till `false` och du har inte
konfigurerade modeller, OpenClaw auto-detekterar i denna ordning och **stannar vid det första
fungerande alternativet**:

1. **Lokala CLI:er** (endast ljud; om installerade)
   - `sherpa-onnx-offline` (kräver `SHERPA_ONNX_MODEL_DIR` med encoder/decoder/joiner/tokens)
   - `whisper-cli` (`whisper-cpp`; använder `WHISPER_CPP_MODEL` eller den medföljande tiny‑modellen)
   - `whisper` (Python‑CLI; laddar ned modeller automatiskt)
2. **Gemini CLI** (`gemini`) med `read_many_files`
3. **Leverantörsnycklar**
   - Ljud: OpenAI → Groq → Deepgram → Google
   - Bild: OpenAI → Anthropic → Google → MiniMax
   - Video: Google

För att inaktivera automatisk identifiering, sätt:

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

Obs: Binär identifiering är best‑effort över macOS/Linux/Windows; säkerställ att CLI:n finns på `PATH` (vi expanderar `~`), eller ange en explicit CLI‑modell med fullständig kommandosökväg.

## Kapaciteter (valfritt)

Om du anger `capabilities`, posten körs endast för dessa mediatyper. För delade
listor kan OpenClaw dra slutsatsen standard:

- `openai`, `anthropic`, `minimax`: **bild**
- `google` (Gemini API): **bild + ljud + video**
- `groq`: **ljud**
- `deepgram`: **ljud**

För CLI-poster, **ställ in `kapaciteter` explicitt** för att undvika överraskande matcher.
Om du utelämnar `capabilities`, är posten berättigad till listan den visas i.

## Matris för leverantörsstöd (OpenClaw‑integrationer)

| Kapacitet | Leverantörsintegration                          | Noteringar                                                                              |
| --------- | ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| Bild      | OpenAI / Anthropic / Google / andra via `pi-ai` | Alla bildkapabla modeller i registret fungerar.                         |
| Ljud      | OpenAI, Groq, Deepgram, Google                  | Leverantörstranskribering (Whisper/Deepgram/Gemini). |
| Video     | Google (Gemini API)          | Leverantörsbaserad videoförståelse.                                     |

## Rekommenderade leverantörer

**Bild**

- Föredra din aktiva modell om den stöder bilder.
- Bra standardval: `openai/gpt-5.2`, `anthropic/claude-opus-4-6`, `google/gemini-3-pro-preview`.

**Ljud**

- `openai/gpt-4o-mini-transcribe`, `groq/whisper-large-v3-turbo` eller `deepgram/nova-3`.
- CLI‑fallback: `whisper-cli` (whisper‑cpp) eller `whisper`.
- Deepgram‑konfigurering: [Deepgram (ljudtranskribering)](/providers/deepgram).

**Video**

- `google/gemini-3-flash-preview` (snabb), `google/gemini-3-pro-preview` (rikare).
- CLI‑fallback: `gemini` CLI (stöder `read_file` på video/ljud).

## Bilagepolicy

Per‑kapacitet `attachments` styr vilka bilagor som bearbetas:

- `mode`: `first` (standard) eller `all`
- `maxAttachments`: begränsa antalet som bearbetas (standard **1**)
- `prefer`: `first`, `last`, `path`, `url`

När `mode: "all"` märks utdata som `[Image 1/2]`, `[Audio 2/2]`, osv.

## Konfigexempel

### 1. Delad modellista + åsidosättningar

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

### 2. Endast ljud + video (bild av)

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

### 3. Valfri bildförståelse

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

### 4. Multimodal enskild post (explicita kapaciteter)

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

## Statusutdata

När medieförståelse körs innehåller `/status` en kort sammanfattningsrad:

```
📎 Media: image ok (openai/gpt-5.2) · audio skipped (maxBytes)
```

Detta visar utfall per kapacitet samt vald leverantör/modell när tillämpligt.

## Noteringar

- Förståelse är **bäst-ansträngning**. Fel blockerar inte svar.
- Bilagor skickas fortfarande till modeller även när förståelse är inaktiverad.
- Använd `scope` för att begränsa var förståelse körs (t.ex. endast DM).

## Relaterad dokumentation

- [Konfiguration](/gateway/configuration)
- [Bild- och mediastöd](/nodes/images)
