---
summary: "Text-zu-Sprache (TTS) für ausgehende Antworten"
read_when:
  - Aktivieren von Text-zu-Sprache für Antworten
  - Konfigurieren von TTS-Anbietern oder -Limits
  - Verwenden von /tts-Befehlen
title: "Text-zu-Sprache"
---

# Text-zu-Sprache (TTS)

OpenClaw kann ausgehende Antworten mithilfe von ElevenLabs, OpenAI oder Edge TTS in Audio umwandeln.
Es funktioniert überall dort, wo OpenClaw Audio senden kann; Telegram erhält eine runde Sprachnachrichten-Blase.

## Unterstützte Dienste

- **ElevenLabs** (primärer oder Fallback-Anbieter)
- **OpenAI** (primärer oder Fallback-Anbieter; wird auch für Zusammenfassungen verwendet)
- **Edge TTS** (primärer oder Fallback-Anbieter; verwendet `node-edge-tts`, Standard, wenn keine API-Schlüssel vorhanden sind)

### Hinweise zu Edge TTS

Edge TTS nutzt den Online-Neural-TTS-Dienst von Microsoft Edge über die Bibliothek
`node-edge-tts`. Es handelt sich um einen gehosteten Dienst (nicht lokal), der Microsoft-Endpunkte
verwendet und keinen API-Schlüssel erfordert. `node-edge-tts` stellt Sprachkonfigurationsoptionen
und Ausgabeformate bereit, jedoch werden nicht alle Optionen vom Edge-Dienst unterstützt. citeturn2search0

Da Edge TTS ein öffentlicher Webdienst ohne veröffentlichte SLA oder Kontingente ist, sollten Sie ihn
als Best-Effort betrachten. Wenn Sie garantierte Limits und Support benötigen, verwenden Sie OpenAI
oder ElevenLabs.
Die Speech-REST-API von Microsoft dokumentiert ein Audio-Limit von 10 Minuten pro
Anfrage; Edge TTS veröffentlicht keine Limits, daher sollten Sie ähnliche oder niedrigere Limits
annehmen. citeturn0search3

## Optionale Schlüssel

Wenn Sie OpenAI oder ElevenLabs verwenden möchten:

- `ELEVENLABS_API_KEY` (oder `XI_API_KEY`)
- `OPENAI_API_KEY`

Edge TTS erfordert **keinen** API-Schlüssel. Wenn keine API-Schlüssel gefunden werden, verwendet
OpenClaw standardmäßig Edge TTS (sofern nicht über `messages.tts.edge.enabled=false` deaktiviert).

Wenn mehrere Anbieter konfiguriert sind, wird der ausgewählte Anbieter zuerst verwendet, die anderen
dienen als Fallback-Optionen.
Die Auto-Zusammenfassung verwendet den konfigurierten
`summaryModel` (oder `agents.defaults.model.primary`), daher muss dieser Anbieter ebenfalls authentifiziert sein,
wenn Sie Zusammenfassungen aktivieren.

## Service-Links

- [OpenAI Text-to-Speech guide](https://platform.openai.com/docs/guides/text-to-speech)
- [OpenAI Audio API reference](https://platform.openai.com/docs/api-reference/audio)
- [ElevenLabs Text to Speech](https://elevenlabs.io/docs/api-reference/text-to-speech)
- [ElevenLabs Authentication](https://elevenlabs.io/docs/api-reference/authentication)
- [node-edge-tts](https://github.com/SchneeHertz/node-edge-tts)
- [Microsoft Speech output formats](https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech#audio-outputs)

## Ist es standardmäßig aktiviert?

Nein. Auto‑TTS ist standardmäßig **aus**. Aktivieren Sie es in der Konfiguration mit
`messages.tts.auto` oder pro Sitzung mit `/tts always` (Alias: `/tts on`).

Edge TTS **ist** standardmäßig aktiviert, sobald TTS eingeschaltet ist, und wird automatisch
verwendet, wenn keine OpenAI- oder ElevenLabs-API-Schlüssel verfügbar sind.

## Konfiguration

Die TTS-Konfiguration befindet sich unter `messages.tts` in `openclaw.json`.
Das vollständige Schema finden Sie unter [Gateway-Konfiguration](/gateway/configuration).

### Minimale Konfiguration (Aktivieren + Anbieter)

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "elevenlabs",
    },
  },
}
```

### OpenAI primär mit ElevenLabs als Fallback

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "openai",
      summaryModel: "openai/gpt-4.1-mini",
      modelOverrides: {
        enabled: true,
      },
      openai: {
        apiKey: "openai_api_key",
        model: "gpt-4o-mini-tts",
        voice: "alloy",
      },
      elevenlabs: {
        apiKey: "elevenlabs_api_key",
        baseUrl: "https://api.elevenlabs.io",
        voiceId: "voice_id",
        modelId: "eleven_multilingual_v2",
        seed: 42,
        applyTextNormalization: "auto",
        languageCode: "en",
        voiceSettings: {
          stability: 0.5,
          similarityBoost: 0.75,
          style: 0.0,
          useSpeakerBoost: true,
          speed: 1.0,
        },
      },
    },
  },
}
```

### Edge TTS primär (kein API-Schlüssel)

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "edge",
      edge: {
        enabled: true,
        voice: "en-US-MichelleNeural",
        lang: "en-US",
        outputFormat: "audio-24khz-48kbitrate-mono-mp3",
        rate: "+10%",
        pitch: "-5%",
      },
    },
  },
}
```

### Edge TTS deaktivieren

```json5
{
  messages: {
    tts: {
      edge: {
        enabled: false,
      },
    },
  },
}
```

### Benutzerdefinierte Limits + Prefs-Pfad

```json5
{
  messages: {
    tts: {
      auto: "always",
      maxTextLength: 4000,
      timeoutMs: 30000,
      prefsPath: "~/.openclaw/settings/tts.json",
    },
  },
}
```

### Nur mit Audio antworten, nachdem eine eingehende Sprachnachricht empfangen wurde

```json5
{
  messages: {
    tts: {
      auto: "inbound",
    },
  },
}
```

### Auto-Zusammenfassung für lange Antworten deaktivieren

```json5
{
  messages: {
    tts: {
      auto: "always",
    },
  },
}
```

Führen Sie dann aus:

```
/tts summary off
```

### Hinweise zu Feldern

- `auto`: Auto‑TTS-Modus (`off`, `always`, `inbound`, `tagged`).
  - `inbound` sendet Audio nur nach einer eingehenden Sprachnachricht.
  - `tagged` sendet Audio nur, wenn die Antwort `[[tts]]`-Tags enthält.
- `enabled`: Legacy-Schalter (doctor migriert dies zu `auto`).
- `mode`: `"final"` (Standard) oder `"all"` (einschließlich Tool-/Block-Antworten).
- `provider`: `"elevenlabs"`, `"openai"` oder `"edge"` (Fallback erfolgt automatisch).
- Wenn `provider` **nicht gesetzt** ist, bevorzugt OpenClaw `openai` (falls Schlüssel),
  dann `elevenlabs` (falls Schlüssel), andernfalls `edge`.
- `summaryModel`: optionales günstiges Modell für Auto-Zusammenfassungen; Standard ist `agents.defaults.model.primary`.
  - Akzeptiert `provider/model` oder einen konfigurierten Modell-Alias.
- `modelOverrides`: erlaubt dem Modell, TTS-Direktiven auszugeben (standardmäßig aktiviert).
- `maxTextLength`: harte Obergrenze für TTS-Eingaben (Zeichen). `/tts audio` schlägt fehl, wenn überschritten.
- `timeoutMs`: Anfrage-Timeout (ms).
- `prefsPath`: überschreibt den lokalen Prefs-JSON-Pfad (Anbieter/Limit/Zusammenfassung).
- `apiKey`-Werte greifen auf Umgebungsvariablen zurück (`ELEVENLABS_API_KEY`/`XI_API_KEY`, `OPENAI_API_KEY`).
- `elevenlabs.baseUrl`: überschreibt die ElevenLabs-API-Basis-URL.
- `elevenlabs.voiceSettings`:
  - `stability`, `similarityBoost`, `style`: `0..1`
  - `useSpeakerBoost`: `true|false`
  - `speed`: `0.5..2.0` (1.0 = normal)
- `elevenlabs.applyTextNormalization`: `auto|on|off`
- `elevenlabs.languageCode`: zweistelliger ISO-639-1-Code (z. B. `en`, `de`)
- `elevenlabs.seed`: Ganzzahl `0..4294967295` (Best-Effort-Determinismus)
- `edge.enabled`: erlaubt die Nutzung von Edge TTS (Standard `true`; kein API-Schlüssel).
- `edge.voice`: Name der Edge-Neural-Stimme (z. B. `en-US-MichelleNeural`).
- `edge.lang`: Sprachcode (z. B. `en-US`).
- `edge.outputFormat`: Edge-Ausgabeformat (z. B. `audio-24khz-48kbitrate-mono-mp3`).
  - Gültige Werte finden Sie unter Microsoft Speech output formats; nicht alle Formate werden von Edge unterstützt.
- `edge.rate` / `edge.pitch` / `edge.volume`: Prozent-Strings (z. B. `+10%`, `-5%`).
- `edge.saveSubtitles`: schreibt JSON-Untertitel neben der Audiodatei.
- `edge.proxy`: Proxy-URL für Edge-TTS-Anfragen.
- `edge.timeoutMs`: Überschreibung des Anfrage-Timeouts (ms).

## Modellgesteuerte Überschreibungen (standardmäßig aktiviert)

Standardmäßig **kann** das Modell TTS-Direktiven für eine einzelne Antwort ausgeben.
Wenn `messages.tts.auto` auf `tagged` gesetzt ist, sind diese Direktiven erforderlich, um Audio auszulösen.

Wenn aktiviert, kann das Modell `[[tts:...]]`-Direktiven ausgeben, um die Stimme
für eine einzelne Antwort zu überschreiben, sowie einen optionalen `[[tts:text]]...[[/tts:text]]`-Block,
um expressive Tags (Lachen, Gesangshinweise usw.) bereitzustellen, die nur im Audio erscheinen sollen.

Beispiel-Antwort-Payload:

```
Here you go.

[[tts:provider=elevenlabs voiceId=pMsXgVXv3BLzUgSXRplE model=eleven_v3 speed=1.1]]
[[tts:text]](laughs) Read the song once more.[[/tts:text]]
```

Verfügbare Direktiven-Schlüssel (wenn aktiviert):

- `provider` (`openai` | `elevenlabs` | `edge`)
- `voice` (OpenAI-Stimme) oder `voiceId` (ElevenLabs)
- `model` (OpenAI-TTS-Modell oder ElevenLabs-Modell-ID)
- `stability`, `similarityBoost`, `style`, `speed`, `useSpeakerBoost`
- `applyTextNormalization` (`auto|on|off`)
- `languageCode` (ISO 639-1)
- `seed`

Alle Modell-Überschreibungen deaktivieren:

```json5
{
  messages: {
    tts: {
      modelOverrides: {
        enabled: false,
      },
    },
  },
}
```

Optionale Allowlist (deaktiviert bestimmte Überschreibungen, während Tags aktiviert bleiben):

```json5
{
  messages: {
    tts: {
      modelOverrides: {
        enabled: true,
        allowProvider: false,
        allowSeed: false,
      },
    },
  },
}
```

## Benutzerbezogene Einstellungen

Slash-Befehle schreiben lokale Überschreibungen nach `prefsPath` (Standard:
`~/.openclaw/settings/tts.json`, überschreiben mit `OPENCLAW_TTS_PREFS` oder
`messages.tts.prefsPath`).

Gespeicherte Felder:

- `enabled`
- `provider`
- `maxLength` (Zusammenfassungs-Schwellenwert; Standard 1500 Zeichen)
- `summarize` (Standard `true`)

Diese überschreiben `messages.tts.*` für diesen Host.

## Ausgabeformate (fest)

- **Telegram**: Opus-Sprachnotiz (`opus_48000_64` von ElevenLabs, `opus` von OpenAI).
  - 48 kHz / 64 kbps ist ein guter Kompromiss für Sprachnotizen und für die runde Blase erforderlich.
- **Andere Kanäle**: MP3 (`mp3_44100_128` von ElevenLabs, `mp3` von OpenAI).
  - 44,1 kHz / 128 kbps ist die Standardbalance für Sprachverständlichkeit.
- **Edge TTS**: verwendet `edge.outputFormat` (Standard `audio-24khz-48kbitrate-mono-mp3`).
  - `node-edge-tts` akzeptiert ein `outputFormat`, aber nicht alle Formate sind
    vom Edge-Dienst verfügbar. citeturn2search0
  - Werte für Ausgabeformate folgen den Microsoft Speech output formats (einschließlich Ogg/WebM Opus). citeturn1search0
  - Telegram `sendVoice` akzeptiert OGG/MP3/M4A; verwenden Sie OpenAI/ElevenLabs, wenn Sie
    garantierte Opus-Sprachnotizen benötigen. citeturn1search1
  - Wenn das konfigurierte Edge-Ausgabeformat fehlschlägt, versucht OpenClaw es erneut mit MP3.

OpenAI-/ElevenLabs-Formate sind fest; Telegram erwartet Opus für das Sprachnotiz-UX.

## Auto-TTS-Verhalten

Wenn aktiviert, führt OpenClaw Folgendes aus:

- überspringt TTS, wenn die Antwort bereits Medien oder eine `MEDIA:`-Direktive enthält.
- überspringt sehr kurze Antworten (< 10 Zeichen).
- fasst lange Antworten bei Aktivierung mit `agents.defaults.model.primary` (oder `summaryModel`) zusammen.
- hängt das generierte Audio an die Antwort an.

Wenn die Antwort `maxLength` überschreitet und die Zusammenfassung deaktiviert ist
(oder kein API-Schlüssel für das Zusammenfassungsmodell vorhanden ist), wird Audio
übersprungen und die normale Textantwort gesendet.

## Ablaufdiagramm

```
Reply -> TTS enabled?
  no  -> send text
  yes -> has media / MEDIA: / short?
          yes -> send text
          no  -> length > limit?
                   no  -> TTS -> attach audio
                   yes -> summary enabled?
                            no  -> send text
                            yes -> summarize (summaryModel or agents.defaults.model.primary)
                                      -> TTS -> attach audio
```

## Verwendung von Slash-Befehlen

Es gibt einen einzigen Befehl: `/tts`.
Details zur Aktivierung finden Sie unter [Slash-Befehle](/tools/slash-commands).

Discord-Hinweis: `/tts` ist ein integrierter Discord-Befehl, daher registriert OpenClaw
dort `/voice` als nativen Befehl. Der Text `/tts ...` funktioniert weiterhin.

```
/tts off
/tts always
/tts inbound
/tts tagged
/tts status
/tts provider openai
/tts limit 2000
/tts summary off
/tts audio Hello from OpenClaw
```

Hinweise:

- Befehle erfordern einen autorisierten Absender (Allowlist-/Owner-Regeln gelten weiterhin).
- `commands.text` oder die Registrierung nativer Befehle muss aktiviert sein.
- `off|always|inbound|tagged` sind sitzungsbezogene Umschalter (`/tts on` ist ein Alias für `/tts always`).
- `limit` und `summary` werden in lokalen Prefs gespeichert, nicht in der Hauptkonfiguration.
- `/tts audio` erzeugt eine einmalige Audioantwort (schaltet TTS nicht ein).

## Agent-Werkzeug

Das Werkzeug `tts` wandelt Text in Sprache um und gibt einen `MEDIA:`-Pfad zurück. Wenn das Ergebnis Telegram-kompatibel ist, enthält das Werkzeug `[[audio_as_voice]]`, sodass
Telegram eine Sprachnachrichten-Blase sendet.

## Gateway-RPC

Gateway-Methoden:

- `tts.status`
- `tts.enable`
- `tts.disable`
- `tts.convert`
- `tts.setProvider`
- `tts.providers`
