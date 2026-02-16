---
summary: "Mode Talk : conversations parole continues avec TTS ElevenLabs"
read_when:
  - Implémentation mode Talk sur macOS/iOS/Android
  - Changement comportement voix/TTS/interrupt
title: "Mode Talk"
---

# Mode Talk

Mode Talk est boucle conversation voix continue :

1. Écouter parole
2. Envoyer transcript au modèle (session main, chat.send)
3. Attendre réponse
4. La parler via ElevenLabs (playback streaming)

## Comportement (macOS)

- **Overlay always-on** pendant mode Talk activé.
- Transitions phase **Listening → Thinking → Speaking**.
- Sur **pause courte** (fenêtre silence), transcript actuel envoyé.
- Réponses **écrites vers WebChat** (même que typing).
- **Interrupt on speech** (défaut activé) : si utilisateur commence parler pendant assistant parle, nous stoppons playback et notons timestamp interruption pour prochain prompt.

## Directives voix dans réponses

Assistant peut préfixer réponse avec **ligne JSON unique** pour contrôler voix :

```json
{ "voice": "<voice-id>", "once": true }
```

Règles :

- Première ligne non-vide uniquement.
- Clés inconnues ignorées.
- `once: true` applique à réponse actuelle uniquement.
- Sans `once`, voix devient nouveau défaut pour mode Talk.
- Ligne JSON strippée avant playback TTS.

Clés supportées :

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

## CLI

```bash
openclaw talk start
openclaw talk stop
openclaw talk status
```

Voir aussi :

- [Voice Wake](/fr-FR/platforms/mac/voicewake)
- [Nœuds](/fr-FR/nodes/index)
- [App macOS](/fr-FR/platforms/macos)
