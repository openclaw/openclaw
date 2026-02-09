---
summary: "„Eingehende Bild-/Audio-/Video-Erkennung (optional) mit Anbieter- und CLI-Fallbacks“"
read_when:
  - Entwurf oder Refactoring der Medienerkennung
  - Feinabstimmung der eingehenden Audio-/Video-/Bildvorverarbeitung
title: "Medienverständnis"
---

# Medienerkennung (Eingehend) — 2026-01-17

OpenClaw kann **eingehende Medien zusammenfassen** (Bild/Audio/Video), bevor die Antwort-Pipeline läuft. Es erkennt automatisch, ob lokale Werkzeuge oder Anbieter-Schlüssel verfügbar sind, und kann deaktiviert oder angepasst werden. Ist die Erkennung ausgeschaltet, erhalten Modelle weiterhin wie gewohnt die Originaldateien/URLs.

## Ziele

- Optional: Vorab-Aufbereitung eingehender Medien zu kurzem Text für schnelleres Routing und bessere Befehlsauswertung.
- Originale Medienweitergabe an das Modell beibehalten (immer).
- Unterstützung von **Anbieter-APIs** und **CLI-Fallbacks**.
- Mehrere Modelle mit geordnetem Fallback (Fehler/Größe/Timeout) erlauben.

## Verhalten auf hoher Ebene

1. Sammeln eingehender Anhänge (`MediaPaths`, `MediaUrls`, `MediaTypes`).
2. Für jede aktivierte Fähigkeit (Bild/Audio/Video) Anhänge gemäß Richtlinie auswählen (Standard: **first**).
3. Den ersten geeigneten Modelletrag wählen (Größe + Fähigkeit + Auth).
4. Wenn ein Modell fehlschlägt oder das Medium zu groß ist, **auf den nächsten Eintrag zurückfallen**.
5. Bei Erfolg:
   - `Body` wird zu einem `[Image]`-, `[Audio]`- oder `[Video]`-Block.
   - Audio setzt `{{Transcript}}`; die Befehlsauswertung verwendet den Caption-Text, sofern vorhanden,
     andernfalls das Transkript.
   - Captions werden als `User text:` innerhalb des Blocks beibehalten.

Wenn die Erkennung fehlschlägt oder deaktiviert ist, **läuft der Antwortfluss weiter** mit dem Originaltext + Anhängen.

## Konfigurationsübersicht

`tools.media` unterstützt **gemeinsame Modelle** sowie Überschreibungen pro Fähigkeit:

- `tools.media.models`: gemeinsame Modellliste (mit `capabilities` steuern).
- `tools.media.image` / `tools.media.audio` / `tools.media.video`:
  - Standards (`prompt`, `maxChars`, `maxBytes`, `timeoutSeconds`, `language`)
  - Anbieter-Überschreibungen (`baseUrl`, `headers`, `providerOptions`)
  - Deepgram-Audiooptionen über `tools.media.audio.providerOptions.deepgram`
  - optionale **fähigkeitsbezogene `models`-Liste** (bevorzugt vor gemeinsamen Modellen)
  - `attachments`-Richtlinie (`mode`, `maxAttachments`, `prefer`)
  - `scope` (optional: Steuerung nach Kanal/Chat-Typ/Sitzungsschlüssel)
- `tools.media.concurrency`: maximale gleichzeitige Fähigkeitsläufe (Standard **2**).

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

### Modelleträge

Jeder `models[]`-Eintrag kann **Anbieter** oder **CLI** sein:

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

CLI-Vorlagen können außerdem verwenden:

- `{{MediaDir}}` (Verzeichnis, das die Mediendatei enthält)
- `{{OutputDir}}` (für diesen Lauf erstelltes Scratch-Verzeichnis)
- `{{OutputBase}}` (Basis-Pfad der Scratch-Datei, ohne Erweiterung)

## Standards und Limits

Empfohlene Standards:

- `maxChars`: **500** für Bild/Video (kurz, befehlsfreundlich)
- `maxChars`: **nicht gesetzt** für Audio (vollständiges Transkript, sofern kein Limit gesetzt ist)
- `maxBytes`:
  - Bild: **10MB**
  - Audio: **20MB**
  - Video: **50MB**

Regeln:

- Überschreitet ein Medium `maxBytes`, wird dieses Modell übersprungen und **das nächste Modell wird versucht**.
- Gibt das Modell mehr als `maxChars` zurück, wird die Ausgabe gekürzt.
- `prompt` ist standardmäßig ein einfaches „Describe the {media}.“ plus die `maxChars`-Leitlinie (nur Bild/Video).
- Wenn `<capability>.enabled: true`, aber keine Modelle konfiguriert sind, versucht OpenClaw das
  **aktive Antwortmodell**, sofern dessen Anbieter die Fähigkeit unterstützt.

### Automatische Erkennung der Medienerkennung (Standard)

Wenn `tools.media.<capability>.enabled` **nicht** auf `false` gesetzt ist und Sie keine
Modelle konfiguriert haben, erkennt OpenClaw automatisch in dieser Reihenfolge und **stoppt bei der ersten
funktionierenden Option**:

1. **Lokale CLIs** (nur Audio; falls installiert)
   - `sherpa-onnx-offline` (erfordert `SHERPA_ONNX_MODEL_DIR` mit Encoder/Decoder/Joiner/Tokens)
   - `whisper-cli` (`whisper-cpp`; verwendet `WHISPER_CPP_MODEL` oder das gebündelte Tiny-Modell)
   - `whisper` (Python-CLI; lädt Modelle automatisch herunter)
2. **Gemini CLI** (`gemini`) mit `read_many_files`
3. **Anbieter-Schlüssel**
   - Audio: OpenAI → Groq → Deepgram → Google
   - Bild: OpenAI → Anthropic → Google → MiniMax
   - Video: Google

Um die automatische Erkennung zu deaktivieren, setzen Sie:

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

Hinweis: Die Binärerkennung ist bestmöglich über macOS/Linux/Windows hinweg; stellen Sie sicher, dass die CLI auf `PATH` liegt (wir erweitern `~`), oder setzen Sie ein explizites CLI-Modell mit vollständigem Befehls-Pfad.

## Fähigkeiten (optional)

Wenn Sie `capabilities` setzen, läuft der Eintrag nur für diese Medientypen. Für gemeinsame
Listen kann OpenClaw Standardwerte ableiten:

- `openai`, `anthropic`, `minimax`: **image**
- `google` (Gemini API): **image + audio + video**
- `groq`: **audio**
- `deepgram`: **audio**

Für CLI-Einträge **setzen Sie `capabilities` explizit**, um überraschende Zuordnungen zu vermeiden.
Wenn Sie `capabilities` weglassen, ist der Eintrag für die Liste geeignet, in der er erscheint.

## Anbieter-Unterstützungsmatrix (OpenClaw-Integrationen)

| Fähigkeit | Anbieter-Integration                              | Hinweise                                                                             |
| --------- | ------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Bild      | OpenAI / Anthropic / Google / andere über `pi-ai` | Jedes bildfähige Modell im Register funktioniert.                    |
| Audio     | OpenAI, Groq, Deepgram, Google                    | Anbieter-Transkription (Whisper/Deepgram/Gemini). |
| Video     | Google (Gemini API)            | Anbieter-Videoerkennung.                                             |

## Empfohlene Anbieter

**Bild**

- Bevorzugen Sie Ihr aktives Modell, wenn es Bilder unterstützt.
- Gute Standards: `openai/gpt-5.2`, `anthropic/claude-opus-4-6`, `google/gemini-3-pro-preview`.

**Audio**

- `openai/gpt-4o-mini-transcribe`, `groq/whisper-large-v3-turbo` oder `deepgram/nova-3`.
- CLI-Fallback: `whisper-cli` (whisper-cpp) oder `whisper`.
- Deepgram-Einrichtung: [Deepgram (Audiotranskription)](/providers/deepgram).

**Video**

- `google/gemini-3-flash-preview` (schnell), `google/gemini-3-pro-preview` (umfangreicher).
- CLI-Fallback: `gemini`-CLI (unterstützt `read_file` für Video/Audio).

## Anhang-Richtlinie

Die fähigkeitsbezogene `attachments` steuert, welche Anhänge verarbeitet werden:

- `mode`: `first` (Standard) oder `all`
- `maxAttachments`: Begrenzung der verarbeiteten Anzahl (Standard **1**)
- `prefer`: `first`, `last`, `path`, `url`

Wenn `mode: "all"`, werden Ausgaben als `[Image 1/2]`, `[Audio 2/2]` usw.

## Konfigurationsbeispiele

### 1. Gemeinsame Modellliste + Überschreibungen

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

### 2. Nur Audio + Video (Bild aus)

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

### 3. Optionale Bilderkennung

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

### 4. Multimodaler Einzeleintrag (explizite Fähigkeiten)

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

## Statusausgabe

Wenn die Medienerkennung läuft, enthält `/status` eine kurze Zusammenfassungszeile:

```
📎 Media: image ok (openai/gpt-5.2) · audio skipped (maxBytes)
```

Diese zeigt pro Fähigkeit die Ergebnisse sowie den gewählten Anbieter/das Modell, falls zutreffend.

## Hinweise

- Die Erkennung ist **Best-Effort**. Fehler blockieren Antworten nicht.
- Anhänge werden auch dann an Modelle weitergereicht, wenn die Erkennung deaktiviert ist.
- Verwenden Sie `scope`, um einzuschränken, wo die Erkennung läuft (z. B.

## Verwandte Dokumente

- [Konfiguration](/gateway/configuration)
- [Bild- & Medienunterstützung](/nodes/images)
