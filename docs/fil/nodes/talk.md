---
summary: "Talk mode: tuloy-tuloy na mga pag-uusap na boses gamit ang ElevenLabs TTS"
read_when:
  - Pagpapatupad ng Talk mode sa macOS/iOS/Android
  - Pagbabago ng voice/TTS/interrupt na asal
title: "Mode ng Talk"
---

# Mode ng Talk

Ang Talk mode ay isang tuloy-tuloy na loop ng pag-uusap na boses:

1. Makinig sa pananalita
2. Ipadala ang transcript sa model (pangunahing session, chat.send)
3. Hintayin ang tugon
4. Bigkasin ito gamit ang ElevenLabs (streaming playback)

## Asal (macOS)

- **Palaging naka-on na overlay** habang naka-enable ang Talk mode.
- Mga paglipat ng yugto: **Listening → Thinking → Speaking**.
- Sa **maikling paghinto** (window ng katahimikan), ipinapadala ang kasalukuyang transcript.
- Ang mga sagot ay **isinusulat sa WebChat** (kapareho ng pagta-type).
- **Interrupt sa pananalita** (default na naka-on): kapag nagsimulang magsalita ang user habang nagsasalita ang assistant, itinitigil ang playback at itinatala ang timestamp ng pag-interrupt para sa susunod na prompt.

## Mga direktiba ng boses sa mga sagot

Maaaring unahan ng assistant ang sagot nito ng **iisang linya ng JSON** para kontrolin ang boses:

```json
{ "voice": "<voice-id>", "once": true }
```

Mga panuntunan:

- Unang hindi bakanteng linya lamang.
- Ang mga hindi kilalang key ay binabalewala.
- Ang `once: true` ay nalalapat lamang sa kasalukuyang sagot.
- Kapag walang `once`, ang boses ay nagiging bagong default para sa Talk mode.
- Inaalis ang JSON line bago ang TTS playback.

Mga suportadong key:

- `voice` / `voice_id` / `voiceId`
- `model` / `model_id` / `modelId`
- `speed`, `rate` (WPM), `stability`, `similarity`, `style`, `speakerBoost`
- `seed`, `normalize`, `lang`, `output_format`, `latency_tier`
- `once`

## Config (`~/.openclaw/openclaw.json`)

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

Mga default:

- `interruptOnSpeech`: true
- `voiceId`: bumabalik sa `ELEVENLABS_VOICE_ID` / `SAG_VOICE_ID` (o sa unang ElevenLabs voice kapag may available na API key)
- `modelId`: default sa `eleven_v3` kapag hindi nakatakda
- `apiKey`: bumabalik sa `ELEVENLABS_API_KEY` (o sa gateway shell profile kung available)
- `outputFormat`: default sa `pcm_44100` sa macOS/iOS at `pcm_24000` sa Android (itakda ang `mp3_*` para pilitin ang MP3 streaming)

## UI sa macOS

- Toggle sa menu bar: **Talk**
- Tab ng config: pangkat na **Talk Mode** (voice id + interrupt toggle)
- Overlay:
  - **Listening**: pumipintig na ulap na may antas ng mic
  - **Thinking**: lumulubog na animation
  - **Speaking**: mga naglalabasang singsing
  - I-click ang ulap: itigil ang pagsasalita
  - I-click ang X: lumabas sa Talk mode

## Mga tala

- Nangangailangan ng pahintulot sa Speech + Microphone.
- Gumagamit ng `chat.send` laban sa session key na `main`.
- Gumagamit ang TTS ng ElevenLabs streaming API na may `ELEVENLABS_API_KEY` at incremental playback sa macOS/iOS/Android para sa mas mababang latency.
- Ang `stability` para sa `eleven_v3` ay bina-validate sa `0.0`, `0.5`, o `1.0`; tumatanggap ang ibang model ng `0..1`.
- Ang `latency_tier` ay bina-validate sa `0..4` kapag itinakda.
- Sinusuportahan ng Android ang mga output format na `pcm_16000`, `pcm_22050`, `pcm_24000`, at `pcm_44100` para sa low-latency AudioTrack streaming.
