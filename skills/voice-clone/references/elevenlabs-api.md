# ElevenLabs API Reference

## Authentication

All requests require `xi-api-key` header with your API key.

Free tier: ~10,000 characters/month, 3 custom voices, instant cloning.

## Endpoints

### Voices

| Method | Endpoint                       | Description                   |
| ------ | ------------------------------ | ----------------------------- |
| GET    | /v1/voices                     | List all voices               |
| GET    | /v1/voices/{voice_id}          | Get voice details             |
| DELETE | /v1/voices/{voice_id}          | Delete a voice                |
| POST   | /v1/voices/add                 | Add/clone a voice (multipart) |
| POST   | /v1/voices/{voice_id}/edit     | Edit voice name/samples       |
| GET    | /v1/voices/{voice_id}/settings | Get voice settings            |

### Text-to-Speech

| Method | Endpoint                             | Description                     |
| ------ | ------------------------------------ | ------------------------------- |
| POST   | /v1/text-to-speech/{voice_id}        | Generate speech (returns audio) |
| POST   | /v1/text-to-speech/{voice_id}/stream | Stream speech (chunked audio)   |

### Models

| Model ID               | Description         | Best For                 |
| ---------------------- | ------------------- | ------------------------ |
| eleven_multilingual_v2 | Latest multilingual | Most use cases           |
| eleven_monolingual_v1  | English only        | Fastest, English content |
| eleven_turbo_v2_5      | Low latency         | Real-time applications   |

## Voice Cloning Types

### Instant Voice Cloning (IVC)

- Available on free tier
- Upload 1+ audio samples
- No training required, instant result
- Quality improves with more/better samples

### Professional Voice Cloning (PVC)

- Requires paid plan
- Upload 30+ minutes of audio
- Training takes hours
- Highest quality reproduction

## Audio Sample Guidelines

| Aspect            | Recommendation                    |
| ----------------- | --------------------------------- |
| Duration          | 30 sec - 3 min per sample         |
| Format            | MP3, WAV, M4A, FLAC, OGG, WEBM    |
| Quality           | 44.1kHz+ sample rate, clear audio |
| Background        | Minimal noise, no music           |
| Speaking style    | Natural conversational tone       |
| Number of samples | 1 minimum, 3-5 recommended        |

## Voice Settings

```json
{
  "stability": 0.5,
  "similarity_boost": 0.75,
  "style": 0.5,
  "use_speaker_boost": true
}
```

| Setting           | Range   | Low value                    | High value                       |
| ----------------- | ------- | ---------------------------- | -------------------------------- |
| stability         | 0.0-1.0 | More variable/expressive     | More consistent/monotone         |
| similarity_boost  | 0.0-1.0 | More variation from original | Closer to original voice         |
| style             | 0.0-1.0 | Less expressive              | More expressive (higher latency) |
| use_speaker_boost | bool    | Standard quality             | Enhanced clarity                 |

## Error Codes

| Code | Meaning                                       |
| ---- | --------------------------------------------- |
| 401  | Invalid API key                               |
| 422  | Invalid request (check voice_id, text length) |
| 429  | Rate limited or quota exceeded                |
| 500  | Server error                                  |

## Rate Limits

- Free tier: ~3 requests/second
- Paid tiers: Higher limits
- Character limits per request: 5,000 (free), 10,000 (paid)
