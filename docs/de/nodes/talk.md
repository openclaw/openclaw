---
summary: "„Talk-Modus: kontinuierliche Sprachgespräche mit ElevenLabs TTS“"
read_when:
  - Implementierung des Talk-Modus auf macOS/iOS/Android
  - Ändern von Sprach-/TTS-/Unterbrechungsverhalten
title: "„Talk-Modus“"
---

# Talk-Modus

Der Talk-Modus ist eine kontinuierliche Sprachgesprächsschleife:

1. Sprache hören
2. Transkript an das Modell senden (Hauptsitzung, chat.send)
3. Auf die Antwort warten
4. Wiedergabe über ElevenLabs (Streaming-Wiedergabe)

## Verhalten (macOS)

- **Always-on-Overlay**, solange der Talk-Modus aktiviert ist.
- Phasenübergänge **Zuhören → Denken → Sprechen**.
- Bei einer **kurzen Pause** (Stillefenster) wird das aktuelle Transkript gesendet.
- Antworten werden **in WebChat geschrieben** (wie beim Tippen).
- **Unterbrechen bei Sprache** (standardmäßig aktiviert): Beginnt der Benutzer zu sprechen, während der Assistent spricht, stoppen wir die Wiedergabe und vermerken den Zeitstempel der Unterbrechung für den nächsten Prompt.

## Sprachdirektiven in Antworten

Der Assistent kann seiner Antwort eine **einzelne JSON-Zeile** voranstellen, um die Stimme zu steuern:

```json
{ "voice": "<voice-id>", "once": true }
```

Regeln:

- Nur die erste nicht-leere Zeile.
- Unbekannte Schlüssel werden ignoriert.
- `once: true` gilt nur für die aktuelle Antwort.
- Ohne `once` wird die Stimme zur neuen Standardstimme für den Talk-Modus.
- Die JSON-Zeile wird vor der TTS-Wiedergabe entfernt.

Unterstützte Schlüssel:

- `voice` / `voice_id` / `voiceId`
- `model` / `model_id` / `modelId`
- `speed`, `rate` (WPM), `stability`, `similarity`, `style`, `speakerBoost`
- `seed`, `normalize`, `lang`, `output_format`, `latency_tier`
- `once`

## Konfiguration (`~/.openclaw/openclaw.json`)

```json5
{
  talk: {
    voiceId: "elevenlabs_voice_id",
    modelId: "eleven_v3",
    outputFormat: "mp3_44100_128",
    apiKey: "elevenlabs_api_key",
    interruptOnSpeech: true,
  },
}
```

Standardwerte:

- `interruptOnSpeech`: true
- `voiceId`: fällt zurück auf `ELEVENLABS_VOICE_ID` / `SAG_VOICE_ID` (oder die erste ElevenLabs-Stimme, wenn ein API-Schlüssel verfügbar ist)
- `modelId`: standardmäßig `eleven_v3`, wenn nicht gesetzt
- `apiKey`: fällt zurück auf `ELEVENLABS_API_KEY` (oder das Gateway-Shell-Profil, falls verfügbar)
- `outputFormat`: standardmäßig `pcm_44100` auf macOS/iOS und `pcm_24000` auf Android (setzen Sie `mp3_*`, um MP3-Streaming zu erzwingen)

## macOS-UI

- Menüleisten-Schalter: **Talk**
- Konfigurations-Tab: Gruppe **Talk-Modus** (Voice-ID + Unterbrechungs-Schalter)
- Overlay:
  - **Zuhören**: Wolkenpulse mit Mikrofonpegel
  - **Denken**: absenkende Animation
  - **Sprechen**: ausstrahlende Ringe
  - Wolke klicken: Sprechen stoppen
  - X klicken: Talk-Modus beenden

## Hinweise

- Erfordert Sprach- und Mikrofonberechtigungen.
- Verwendet `chat.send` gegen den Sitzungsschlüssel `main`.
- TTS nutzt die ElevenLabs-Streaming-API mit `ELEVENLABS_API_KEY` und inkrementeller Wiedergabe auf macOS/iOS/Android für geringere Latenz.
- `stability` für `eleven_v3` wird auf `0.0`, `0.5` oder `1.0` validiert; andere Modelle akzeptieren `0..1`.
- `latency_tier` wird bei Setzung auf `0..4` validiert.
- Android unterstützt die Ausgabeformate `pcm_16000`, `pcm_22050`, `pcm_24000` und `pcm_44100` für AudioTrack-Streaming mit niedriger Latenz.
