---
summary: "Inkomende beeld-/audio-/videoverwerking (optioneel) met provider- en CLI-terugvalopties"
read_when:
  - Ontwerpen of refactoren van mediaverwerking
  - Afstemmen van inkomende audio-/video-/beeldvoorverwerking
title: "Media begrijpen"
---

# Mediaverwerking (inkomend) — 2026-01-17

OpenClaw kan **inkomende media samenvatten** (beeld/audio/video) voordat de antwoordpipeline start. Het detecteert automatisch wanneer lokale tools of provider-sleutels beschikbaar zijn en kan worden uitgeschakeld of aangepast. Als verwerking is uitgeschakeld, ontvangen modellen nog steeds de oorspronkelijke bestanden/URL’s zoals gebruikelijk.

## Doelen

- Optioneel: inkomende media vooraf samenvatten tot korte tekst voor snellere routering + betere commandoparsing.
- Originele mediadoorgifte aan het model behouden (altijd).
- Ondersteuning voor **provider-API’s** en **CLI-terugvalopties**.
- Meerdere modellen met geordende terugval (fout/grootte/time-out).

## Hoog-niveaugedrag

1. Verzamel inkomende bijlagen (`MediaPaths`, `MediaUrls`, `MediaTypes`).
2. Selecteer per ingeschakelde capability (beeld/audio/video) bijlagen volgens beleid (standaard: **eerste**).
3. Kies de eerste geschikte modelvermelding (grootte + capability + authenticatie).
4. Als een model faalt of de media te groot is, **val terug op de volgende vermelding**.
5. Bij succes:
   - `Body` wordt een `[Image]`-, `[Audio]`- of `[Video]`-blok.
   - Audio stelt `{{Transcript}}` in; commandoparsing gebruikt bijschrifttekst indien aanwezig,
     anders het transcript.
   - Bijschriften blijven behouden als `User text:` binnen het blok.

Als verwerking faalt of is uitgeschakeld, **gaat de antwoordflow verder** met de oorspronkelijke body + bijlagen.

## Config-overzicht

`tools.media` ondersteunt **gedeelde modellen** plus overrides per capability:

- `tools.media.models`: gedeelde modellijst (gebruik `capabilities` om te begrenzen).
- `tools.media.image` / `tools.media.audio` / `tools.media.video`:
  - standaardwaarden (`prompt`, `maxChars`, `maxBytes`, `timeoutSeconds`, `language`)
  - provider-overrides (`baseUrl`, `headers`, `providerOptions`)
  - Deepgram-audio-opties via `tools.media.audio.providerOptions.deepgram`
  - optionele **per-capability `models`-lijst** (heeft voorrang op gedeelde modellen)
  - `attachments`-beleid (`mode`, `maxAttachments`, `prefer`)
  - `scope` (optionele begrenzing per kanaal/chatType/sessiesleutel)
- `tools.media.concurrency`: maximaal gelijktijdige capability-runs (standaard **2**).

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

### Modelvermeldingen

Elke `models[]`-vermelding kan **provider** of **CLI** zijn:

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

CLI-sjablonen kunnen ook gebruiken:

- `{{MediaDir}}` (map met het mediabestand)
- `{{OutputDir}}` (scratch-map die voor deze run wordt aangemaakt)
- `{{OutputBase}}` (basis-pad van het scratch-bestand, zonder extensie)

## Standaardwaarden en limieten

Aanbevolen standaardwaarden:

- `maxChars`: **500** voor beeld/video (kort, commandovriendelijk)
- `maxChars`: **niet ingesteld** voor audio (volledig transcript tenzij je een limiet instelt)
- `maxBytes`:
  - beeld: **10MB**
  - audio: **20MB**
  - video: **50MB**

Regels:

- Als media `maxBytes` overschrijdt, wordt dat model overgeslagen en **wordt het volgende model geprobeerd**.
- Als het model meer dan `maxChars` retourneert, wordt de uitvoer afgekapt.
- `prompt` is standaard een eenvoudige “Describe the {media}.” plus de `maxChars`-richtlijnen (alleen beeld/video).
- Als `<capability>.enabled: true` maar er geen modellen zijn geconfigureerd, probeert OpenClaw het
  **actieve antwoordmodel** wanneer de provider die capability ondersteunt.

### Automatische detectie van mediaverwerking (standaard)

Als `tools.media.<capability>.enabled` **niet** is ingesteld op `false` en je geen
modellen hebt geconfigureerd, detecteert OpenClaw automatisch in deze volgorde en **stopt bij de eerste werkende optie**:

1. **Lokale CLI’s** (alleen audio; indien geïnstalleerd)
   - `sherpa-onnx-offline` (vereist `SHERPA_ONNX_MODEL_DIR` met encoder/decoder/joiner/tokens)
   - `whisper-cli` (`whisper-cpp`; gebruikt `WHISPER_CPP_MODEL` of het meegeleverde tiny model)
   - `whisper` (Python CLI; downloadt modellen automatisch)
2. **Gemini CLI** (`gemini`) met `read_many_files`
3. **Provider-sleutels**
   - Audio: OpenAI → Groq → Deepgram → Google
   - Beeld: OpenAI → Anthropic → Google → MiniMax
   - Video: Google

Om automatische detectie uit te schakelen, stel in:

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

Opmerking: binaire detectie is best-effort op macOS/Linux/Windows; zorg dat de CLI op `PATH` staat (we breiden `~` uit), of stel een expliciet CLI-model in met een volledig commandopad.

## Capabilities (optioneel)

Als je `capabilities` instelt, wordt de vermelding alleen uitgevoerd voor die mediatypen. Voor gedeelde lijsten kan OpenClaw standaardwaarden afleiden:

- `openai`, `anthropic`, `minimax`: **beeld**
- `google` (Gemini API): **beeld + audio + video**
- `groq`: **audio**
- `deepgram`: **audio**

Voor CLI-vermeldingen **stel `capabilities` expliciet in** om verrassende matches te voorkomen.
Als je `capabilities` weglaat, komt de vermelding in aanmerking voor de lijst waarin deze verschijnt.

## Provider-ondersteuningsmatrix (OpenClaw-integraties)

| Capability | Providerintegratie                                | Notities                                                                           |
| ---------- | ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Beeld      | OpenAI / Anthropic / Google / anderen via `pi-ai` | Elk beeldgeschikt model in het register werkt.                     |
| Audio      | OpenAI, Groq, Deepgram, Google                    | Providertranscriptie (Whisper/Deepgram/Gemini). |
| Video      | Google (Gemini API)            | Provider videoverwerking.                                          |

## Aanbevolen providers

**Beeld**

- Geef de voorkeur aan je actieve model als het beelden ondersteunt.
- Goede standaardkeuzes: `openai/gpt-5.2`, `anthropic/claude-opus-4-6`, `google/gemini-3-pro-preview`.

**Audio**

- `openai/gpt-4o-mini-transcribe`, `groq/whisper-large-v3-turbo` of `deepgram/nova-3`.
- CLI-terugvaloptie: `whisper-cli` (whisper-cpp) of `whisper`.
- Deepgram-instelling: [Deepgram (audio transcriptie)](/providers/deepgram).

**Video**

- `google/gemini-3-flash-preview` (snel), `google/gemini-3-pro-preview` (rijker).
- CLI-terugvaloptie: `gemini` CLI (ondersteunt `read_file` voor video/audio).

## Bijlagebeleid

Per-capability `attachments` bepaalt welke bijlagen worden verwerkt:

- `mode`: `first` (standaard) of `all`
- `maxAttachments`: maximum aantal te verwerken (standaard **1**)
- `prefer`: `first`, `last`, `path`, `url`

Wanneer `mode: "all"`, worden outputs gelabeld als `[Image 1/2]`, `[Audio 2/2]`, enz.

## Config-voorbeelden

### 1. Gedeelde modellijst + overrides

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

### 2. Alleen audio + video (beeld uit)

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

### 3. Optionele beeldverwerking

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

### 4. Multimodale enkele vermelding (expliciete capabilities)

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

## Statusuitvoer

Wanneer mediaverwerking draait, bevat `/status` een korte samenvattingsregel:

```
📎 Media: image ok (openai/gpt-5.2) · audio skipped (maxBytes)
```

Dit toont per-capability resultaten en, waar van toepassing, de gekozen provider/het gekozen model.

## Notities

- Verwerking is **best-effort**. Fouten blokkeren antwoorden niet.
- Bijlagen worden nog steeds aan modellen doorgegeven, zelfs wanneer verwerking is uitgeschakeld.
- Gebruik `scope` om te beperken waar verwerking draait (bijv. alleen DM’s).

## Gerelateerde documentatie

- [Configuratie](/gateway/configuration)
- [Beeld- & media-ondersteuning](/nodes/images)
