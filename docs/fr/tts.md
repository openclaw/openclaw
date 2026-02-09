---
summary: "Synthèse vocale (TTS) pour les réponses sortantes"
read_when:
  - Activation de la synthèse vocale pour les réponses
  - Configuration des fournisseurs TTS ou des limites
  - Utilisation des commandes /tts
title: "Synthèse vocale"
---

# Synthèse vocale (TTS)

OpenClaw peut convertir les réponses sortantes en audio à l’aide d’ElevenLabs, d’OpenAI ou d’Edge TTS.
Cela fonctionne partout où OpenClaw peut envoyer de l’audio ; Telegram affiche une bulle de note vocale ronde.

## Services pris en charge

- **ElevenLabs** (fournisseur principal ou de secours)
- **OpenAI** (fournisseur principal ou de secours ; également utilisé pour les résumés)
- **Edge TTS** (fournisseur principal ou de secours ; utilise `node-edge-tts`, par défaut en l’absence de clés API)

### Notes sur Edge TTS

Edge TTS utilise le service TTS neuronal en ligne de Microsoft Edge via la bibliothèque
`node-edge-tts`. Il s’agit d’un service hébergé (non local), utilisant les points de terminaison de Microsoft,
et ne nécessite pas de clé API. `node-edge-tts` expose des options de configuration de la voix
et des formats de sortie, mais toutes les options ne sont pas prises en charge par le service Edge. citeturn2search0

Comme Edge TTS est un service web public sans SLA ni quota publiés, considérez‑le comme « best‑effort ». Si vous avez besoin de limites garanties et de support, utilisez OpenAI ou ElevenLabs.
L’API REST Microsoft Speech documente une limite de 10 minutes d’audio par requête ; Edge TTS
ne publie pas de limites, supposez donc des limites similaires ou inférieures. citeturn0search3

## Clés facultatives

Si vous souhaitez utiliser OpenAI ou ElevenLabs :

- `ELEVENLABS_API_KEY` (ou `XI_API_KEY`)
- `OPENAI_API_KEY`

Edge TTS **ne** nécessite **pas** de clé API. Si aucune clé API n’est trouvée, OpenClaw
utilise Edge TTS par défaut (sauf si désactivé via `messages.tts.edge.enabled=false`).

Si plusieurs fournisseurs sont configurés, le fournisseur sélectionné est utilisé en premier
et les autres servent de solutions de secours.
Le résumé automatique utilise le `summaryModel` configuré (ou `agents.defaults.model.primary`),
ce fournisseur doit donc également être authentifié si vous activez les résumés.

## Liens vers les services

- [Guide OpenAI Text-to-Speech](https://platform.openai.com/docs/guides/text-to-speech)
- [Référence de l’API Audio OpenAI](https://platform.openai.com/docs/api-reference/audio)
- [ElevenLabs Text to Speech](https://elevenlabs.io/docs/api-reference/text-to-speech)
- [Authentification ElevenLabs](https://elevenlabs.io/docs/api-reference/authentication)
- [node-edge-tts](https://github.com/SchneeHertz/node-edge-tts)
- [Formats de sortie Microsoft Speech](https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech#audio-outputs)

## Est-ce activé par défaut ?

Non. L’auto‑TTS est **désactivé** par défaut. Activez‑le dans la configuration avec
`messages.tts.auto` ou par session avec `/tts always` (alias : `/tts on`).

Edge TTS **est** activé par défaut une fois le TTS activé, et est utilisé automatiquement
lorsqu’aucune clé API OpenAI ou ElevenLabs n’est disponible.

## Configuration

La configuration TTS se trouve sous `messages.tts` dans `openclaw.json`.
Le schéma complet est disponible dans la [Configuration de la Gateway](/gateway/configuration).

### Configuration minimale (activation + fournisseur)

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

### OpenAI principal avec ElevenLabs en secours

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

### Edge TTS principal (sans clé API)

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

### Désactiver Edge TTS

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

### Limites personnalisées + chemin des préférences

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

### Répondre uniquement avec de l’audio après une note vocale entrante

```json5
{
  messages: {
    tts: {
      auto: "inbound",
    },
  },
}
```

### Désactiver le résumé automatique pour les réponses longues

```json5
{
  messages: {
    tts: {
      auto: "always",
    },
  },
}
```

Ensuite, exécutez :

```
/tts summary off
```

### Notes sur les champs

- `auto` : mode auto‑TTS (`off`, `always`, `inbound`, `tagged`).
  - `inbound` n’envoie de l’audio qu’après une note vocale entrante.
  - `tagged` n’envoie de l’audio que lorsque la réponse inclut des balises `[[tts]]`.
- `enabled` : bascule héritée (le doctor migre ceci vers `auto`).
- `mode` : `"final"` (par défaut) ou `"all"` (inclut les réponses d’outil/bloc).
- `provider` : `"elevenlabs"`, `"openai"` ou `"edge"` (le secours est automatique).
- Si `provider` n’est **pas** défini, OpenClaw préfère `openai` (si clé), puis `elevenlabs` (si clé),
  sinon `edge`.
- `summaryModel` : modèle économique optionnel pour le résumé automatique ; par défaut `agents.defaults.model.primary`.
  - Accepte `provider/model` ou un alias de modèle configuré.
- `modelOverrides` : autoriser le modèle à émettre des directives TTS (activé par défaut).
- `maxTextLength` : plafond strict pour l’entrée TTS (caractères). `/tts audio` échoue en cas de dépassement.
- `timeoutMs` : délai d’expiration de la requête (ms).
- `prefsPath` : remplacer le chemin local du JSON de préférences (fournisseur/limite/résumé).
- Les valeurs de `apiKey` retombent sur les variables d’environnement (`ELEVENLABS_API_KEY`/`XI_API_KEY`, `OPENAI_API_KEY`).
- `elevenlabs.baseUrl` : remplacer l’URL de base de l’API ElevenLabs.
- `elevenlabs.voiceSettings` :
  - `stability`, `similarityBoost`, `style` : `0..1`
  - `useSpeakerBoost` : `true|false`
  - `speed` : `0.5..2.0` (1.0 = normal)
- `elevenlabs.applyTextNormalization` : `auto|on|off`
- `elevenlabs.languageCode` : ISO 639‑1 à 2 lettres (p. ex. `en`, `de`)
- `elevenlabs.seed` : entier `0..4294967295` (déterminisme « best‑effort »)
- `edge.enabled` : autoriser l’utilisation d’Edge TTS (par défaut `true` ; sans clé API).
- `edge.voice` : nom de la voix neuronale Edge (p. ex. `en-US-MichelleNeural`).
- `edge.lang` : code langue (p. ex. `en-US`).
- `edge.outputFormat` : format de sortie Edge (p. ex. `audio-24khz-48kbitrate-mono-mp3`).
  - Voir les formats de sortie Microsoft Speech pour les valeurs valides ; tous les formats ne sont pas pris en charge par Edge.
- `edge.rate` / `edge.pitch` / `edge.volume` : chaînes de pourcentage (p. ex. `+10%`, `-5%`).
- `edge.saveSubtitles` : écrire des sous‑titres JSON à côté du fichier audio.
- `edge.proxy` : URL de proxy pour les requêtes Edge TTS.
- `edge.timeoutMs` : remplacement du délai d’expiration de la requête (ms).

## Remplacements pilotés par le modèle (activés par défaut)

Par défaut, le modèle **peut** émettre des directives TTS pour une réponse unique.
Lorsque `messages.tts.auto` est `tagged`, ces directives sont requises pour déclencher l’audio.

Lorsqu’elles sont activées, le modèle peut émettre des directives `[[tts:...]]` pour
remplacer la voix pour une réponse unique, ainsi qu’un bloc `[[tts:text]]...[[/tts:text]]` optionnel pour
fournir des balises expressives (rires, indications de chant, etc.) qui ne doivent apparaître
que dans l’audio.

Exemple de charge utile de réponse :

```
Here you go.

[[tts:provider=elevenlabs voiceId=pMsXgVXv3BLzUgSXRplE model=eleven_v3 speed=1.1]]
[[tts:text]](laughs) Read the song once more.[[/tts:text]]
```

Clés de directive disponibles (lorsqu’elles sont activées) :

- `provider` (`openai` | `elevenlabs` | `edge`)
- `voice` (voix OpenAI) ou `voiceId` (ElevenLabs)
- `model` (modèle TTS OpenAI ou identifiant de modèle ElevenLabs)
- `stability`, `similarityBoost`, `style`, `speed`, `useSpeakerBoost`
- `applyTextNormalization` (`auto|on|off`)
- `languageCode` (ISO 639‑1)
- `seed`

Désactiver tous les remplacements du modèle :

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

Liste d’autorisation optionnelle (désactiver des remplacements spécifiques tout en conservant les balises) :

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

## Préférences par utilisateur

Les commandes slash écrivent des remplacements locaux dans `prefsPath` (par défaut :
`~/.openclaw/settings/tts.json`, remplaçable avec `OPENCLAW_TTS_PREFS` ou
`messages.tts.prefsPath`).

Champs stockés :

- `enabled`
- `provider`
- `maxLength` (seuil de résumé ; 1500 caractères par défaut)
- `summarize` (par défaut `true`)

Ils remplacent `messages.tts.*` pour cet hôte.

## Formats de sortie (fixes)

- **Telegram** : note vocale Opus (`opus_48000_64` depuis ElevenLabs, `opus` depuis OpenAI).
  - 48 kHz / 64 kbps constitue un bon compromis pour les notes vocales et est requis pour la bulle ronde.
- **Autres canaux** : MP3 (`mp3_44100_128` depuis ElevenLabs, `mp3` depuis OpenAI).
  - 44,1 kHz / 128 kbps est l’équilibre par défaut pour la clarté de la parole.
- **Edge TTS** : utilise `edge.outputFormat` (par défaut `audio-24khz-48kbitrate-mono-mp3`).
  - `node-edge-tts` accepte un `outputFormat`, mais tous les formats ne sont pas disponibles
    depuis le service Edge. citeturn2search0
  - Les valeurs de format de sortie suivent les formats Microsoft Speech (y compris Ogg/WebM Opus). citeturn1search0
  - Telegram `sendVoice` accepte OGG/MP3/M4A ; utilisez OpenAI/ElevenLabs si vous avez besoin
    de notes vocales Opus garanties. citeturn1search1
  - Si le format de sortie Edge configuré échoue, OpenClaw réessaie avec MP3.

Les formats OpenAI/ElevenLabs sont fixes ; Telegram attend de l’Opus pour l’UX de note vocale.

## Comportement de l’auto‑TTS

Lorsqu’il est activé, OpenClaw :

- ignore le TTS si la réponse contient déjà un média ou une directive `MEDIA:`.
- ignore les réponses très courtes (< 10 caractères).
- résume les réponses longues lorsque cela est activé en utilisant `agents.defaults.model.primary` (ou `summaryModel`).
- joint l’audio généré à la réponse.

Si la réponse dépasse `maxLength` et que le résumé est désactivé (ou qu’aucune clé API
n’est disponible pour le modèle de résumé), l’audio est ignoré et la réponse texte normale est envoyée.

## Schéma de flux

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

## Utilisation des commandes slash

Il existe une seule commande : `/tts`.
Voir [Commandes slash](/tools/slash-commands) pour les détails d’activation.

Note Discord : `/tts` est une commande intégrée de Discord ; OpenClaw enregistre donc
`/voice` comme commande native sur cette plateforme. Le texte `/tts ...` fonctionne toujours.

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

Notes :

- Les commandes nécessitent un expéditeur autorisé (les règles de liste d’autorisation/propriétaire s’appliquent toujours).
- `commands.text` ou l’enregistrement de commandes natives doit être activé.
- `off|always|inbound|tagged` sont des bascules par session (`/tts on` est un alias de `/tts always`).
- `limit` et `summary` sont stockés dans les préférences locales, pas dans la configuration principale.
- `/tts audio` génère une réponse audio ponctuelle (n’active/désactive pas le TTS).

## Outil d’agent

L’outil `tts` convertit le texte en parole et renvoie un chemin `MEDIA:`. Lorsque le
résultat est compatible Telegram, l’outil inclut `[[audio_as_voice]]` afin que
Telegram envoie une bulle vocale.

## RPC de la Gateway

Méthodes de la Gateway :

- `tts.status`
- `tts.enable`
- `tts.disable`
- `tts.convert`
- `tts.setProvider`
- `tts.providers`
