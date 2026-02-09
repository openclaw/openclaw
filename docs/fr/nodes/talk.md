---
summary: "Mode Talk : conversations vocales continues avec la synthèse vocale ElevenLabs"
read_when:
  - Mise en œuvre du mode Talk sur macOS/iOS/Android
  - Modification du comportement de la voix/TTS/des interruptions
title: "Mode Talk"
---

# Mode Talk

Le mode Talk est une boucle de conversation vocale continue :

1. Écouter la parole
2. Envoyer la transcription au modèle (session principale, chat.send)
3. Attendre la réponse
4. La prononcer via ElevenLabs (lecture en streaming)

## Comportement (macOS)

- **Superposition toujours active** tant que le mode Talk est activé.
- Transitions de phase **Écoute → Réflexion → Parole**.
- Lors d’une **courte pause** (fenêtre de silence), la transcription courante est envoyée.
- Les réponses sont **écrites dans WebChat** (comme lors de la saisie).
- **Interruption à la parole** (activée par défaut) : si l’utilisateur commence à parler pendant que l’assistant parle, nous arrêtons la lecture et notons l’horodatage d’interruption pour la prochaine invite.

## Directives vocales dans les réponses

L’assistant peut préfixer sa réponse par **une seule ligne JSON** pour contrôler la voix :

```json
{ "voice": "<voice-id>", "once": true }
```

Règles :

- Première ligne non vide uniquement.
- Les clés inconnues sont ignorées.
- `once: true` s’applique uniquement à la réponse courante.
- Sans `once`, la voix devient la nouvelle valeur par défaut pour le mode Talk.
- La ligne JSON est supprimée avant la lecture TTS.

Clés prises en charge :

- `voice` / `voice_id` / `voiceId`
- `model` / `model_id` / `modelId`
- `speed`, `rate` (WPM), `stability`, `similarity`, `style`, `speakerBoost`
- `seed`, `normalize`, `lang`, `output_format`, `latency_tier`
- `once`

## Configuration (`~/.openclaw/openclaw.json`)

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

Valeurs par défaut :

- `interruptOnSpeech` : true
- `voiceId` : revient à `ELEVENLABS_VOICE_ID` / `SAG_VOICE_ID` (ou à la première voix ElevenLabs lorsque la clé API est disponible)
- `modelId` : par défaut `eleven_v3` lorsqu’il n’est pas défini
- `apiKey` : revient à `ELEVENLABS_API_KEY` (ou au profil shell de la passerelle s’il est disponible)
- `outputFormat` : par défaut `pcm_44100` sur macOS/iOS et `pcm_24000` sur Android (définir `mp3_*` pour forcer le streaming MP3)

## Interface macOS

- Bouton de la barre de menus : **Talk**
- Onglet de configuration : groupe **Mode Talk** (ID de voix + bascule d’interruption)
- Superposition :
  - **Écoute** : nuage pulsant avec le niveau du micro
  - **Réflexion** : animation d’enfoncement
  - **Parole** : anneaux rayonnants
  - Cliquer sur le nuage : arrêter la parole
  - Cliquer sur X : quitter le mode Talk

## Notes

- Nécessite les autorisations Parole + Microphone.
- Utilise `chat.send` avec la clé de session `main`.
- La TTS utilise l’API de streaming ElevenLabs avec `ELEVENLABS_API_KEY` et une lecture incrémentale sur macOS/iOS/Android pour une latence réduite.
- `stability` pour `eleven_v3` est validé sur `0.0`, `0.5` ou `1.0` ; les autres modèles acceptent `0..1`.
- `latency_tier` est validé sur `0..4` lorsqu’il est défini.
- Android prend en charge les formats de sortie `pcm_16000`, `pcm_22050`, `pcm_24000` et `pcm_44100` pour le streaming AudioTrack à faible latence.
