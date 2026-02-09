---
summary: "Talk-läge: kontinuerliga röstkonversationer med ElevenLabs TTS"
read_when:
  - Implementerar Talk-läge på macOS/iOS/Android
  - Ändrar röst/TTS/avbrottsbeteende
title: "Talk-läge"
---

# Talk-läge

Talk-läge är en kontinuerlig röstkonversationsloop:

1. Lyssna efter tal
2. Skicka transkriptionen till modellen (huvudsession, chat.send)
3. Vänta på svaret
4. Läs upp det via ElevenLabs (strömmad uppspelning)

## Beteende (macOS)

- **Alltid-på-överlägg** medan Talk-läge är aktiverat.
- Fasövergångar **Lyssnar → Tänker → Talar**.
- Vid en **kort paus** (tystnadsfönster) skickas den aktuella transkriptionen.
- Svar **skrivs till WebChat** (samma som att skriva).
- **Avbryt vid tal** (på som standard): om användaren börjar prata medan assistenten talar stoppar vi uppspelningen och noterar avbrottets tidsstämpel för nästa prompt.

## Röstdirektiv i svar

Assistenten kan inleda sitt svar med **en enda JSON-rad** för att styra rösten:

```json
{ "voice": "<voice-id>", "once": true }
```

Regler:

- Endast första icke-tomma raden.
- Okända nycklar ignoreras.
- `once: true` gäller endast för det aktuella svaret.
- Utan `once` blir rösten den nya standarden för Talk-läge.
- JSON-raden tas bort före TTS-uppspelning.

Stödda nycklar:

- `voice` / `voice_id` / `voiceId`
- `model` / `model_id` / `modelId`
- `speed`, `rate` (WPM), `stability`, `similarity`, `style`, `speakerBoost`
- `seed`, `normalize`, `lang`, `output_format`, `latency_tier`
- `once`

## Konfig (`~/.openclaw/openclaw.json`)

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

Standardvärden:

- `interruptOnSpeech`: true
- `voiceId`: faller tillbaka till `ELEVENLABS_VOICE_ID` / `SAG_VOICE_ID` (eller första ElevenLabs-rösten när API-nyckel är tillgänglig)
- `modelId`: standard till `eleven_v3` när den inte är satt
- `apiKey`: faller tillbaka till `ELEVENLABS_API_KEY` (eller gateway-skalprofil om tillgänglig)
- `outputFormat`: standard till `pcm_44100` på macOS/iOS och `pcm_24000` på Android (ställ in `mp3_*` för att tvinga MP3-strömning)

## macOS-gränssnitt

- Menyradsväxel: **Talk**
- Konfigflik: gruppen **Talk-läge** (röst-id + avbrottsväxel)
- Överlägg:
  - **Lyssnar**: moln pulserar med mikrofonnivå
  - **Tänker**: sjunkande animation
  - **Talar**: utstrålande ringar
  - Klicka på molnet: stoppa tal
  - Klicka på X: avsluta Talk-läge

## Noteringar

- Kräver behörigheter för Tal + Mikrofon.
- Använder `chat.send` mot sessionsnyckeln `main`.
- TTS använder ElevenLabs strömnings-API med `ELEVENLABS_API_KEY` och inkrementell uppspelning på macOS/iOS/Android för lägre latens.
- `stability` för `eleven_v3` valideras till `0.0`, `0.5` eller `1.0`; andra modeller accepterar `0..1`.
- `latency_tier` valideras till `0..4` när den är satt.
- Android stöder utdataformaten `pcm_16000`, `pcm_22050`, `pcm_24000` och `pcm_44100` för låg-latens AudioTrack-strömning.
