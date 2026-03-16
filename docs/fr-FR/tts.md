---
summary: "Synthèse vocale (TTS) pour les réponses sortantes"
read_when:
  - Activer la synthèse vocale pour les réponses
  - Configurer les fournisseurs TTS ou les limites
  - Utiliser les commandes /tts
title: "Synthèse Vocale"
---

# Synthèse vocale (TTS)

OpenClaw peut convertir les réponses sortantes en audio en utilisant ElevenLabs, OpenAI ou Edge TTS. Cela fonctionne partout où OpenClaw peut envoyer de l'audio ; Telegram obtient une bulle de note vocale ronde.

## Services supportés

- **ElevenLabs** (fournisseur principal ou de repli)
- **OpenAI** (fournisseur principal ou de repli ; également utilisé pour les résumés)
- **Edge TTS** (fournisseur principal ou de repli ; utilise `node-edge-tts`, par défaut quand pas de clés API)

### Notes Edge TTS

Edge TTS utilise le service TTS neuronal en ligne de Microsoft Edge via la bibliothèque `node-edge-tts`. C'est un service hébergé (pas local), utilise les points de terminaison Microsoft et ne nécessite pas de clé API. `node-edge-tts` expose des options de configuration vocale et des formats de sortie, mais toutes les options ne sont pas supportées par le service Edge.

Parce qu'Edge TTS est un service web public sans SLA ou quota publié, traitez-le comme best-effort. Si vous avez besoin de limites garanties et de support, utilisez OpenAI ou ElevenLabs. L'API REST Speech de Microsoft documente une limite audio de 10 minutes par requête ; Edge TTS ne publie pas de limites, donc assumez des limites similaires ou inférieures.

## Clés optionnelles

Si vous voulez OpenAI ou ElevenLabs :

- `ELEVENLABS_API_KEY` (ou `XI_API_KEY`)
- `OPENAI_API_KEY`

Edge TTS **ne nécessite pas** de clé API. Si aucune clé API n'est trouvée, OpenClaw bascule par défaut vers Edge TTS (sauf si désactivé via `messages.tts.edge.enabled=false`).

Si plusieurs fournisseurs sont configurés, le fournisseur sélectionné est utilisé en premier et les autres sont des options de repli. Le résumé automatique utilise le `summaryModel` configuré (ou `agents.defaults.model.primary`), donc ce fournisseur doit également être authentifié si vous activez les résumés.

## Liens de service

- [Guide OpenAI Text-to-Speech](https://platform.openai.com/docs/guides/text-to-speech)
- [Référence API Audio OpenAI](https://platform.openai.com/docs/api-reference/audio)
- [ElevenLabs Text to Speech](https://elevenlabs.io/docs/api-reference/text-to-speech)
- [ElevenLabs Authentication](https://elevenlabs.io/docs/api-reference/authentication)
- [node-edge-tts](https://github.com/SchneeHertz/node-edge-tts)
- [Formats de sortie Microsoft Speech](https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech#audio-outputs)

## Est-ce activé par défaut ?

Non. Auto-TTS est **désactivé** par défaut. Activez-le dans la config avec `messages.tts.auto` ou par session avec `/tts always` (alias : `/tts on`).

Edge TTS **est** activé par défaut une fois que TTS est activé, et est utilisé automatiquement quand aucune clé API OpenAI ou ElevenLabs n'est disponible.

## Configuration

La config TTS vit sous `messages.tts` dans `openclaw.json`. Le schéma complet est dans [Configuration de la Passerelle](/fr-FR/gateway/configuration).

### Config minimale (activer + fournisseur)

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

### OpenAI principal avec repli ElevenLabs

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

### Edge TTS principal (pas de clé API)

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

### Limites personnalisées + chemin de préférences

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

### Répondre uniquement avec audio après une note vocale entrante

```json5
{
  messages: {
    tts: {
      auto: "inbound",
    },
  },
}
```

### Désactiver le résumé automatique pour longues réponses

```json5
{
  messages: {
    tts: {
      auto: "always",
    },
  },
}
```

Puis exécutez :

```
/tts summary off
```

### Notes sur les champs

- `auto` : mode auto-TTS (`off`, `always`, `inbound`, `tagged`).
  - `inbound` envoie uniquement de l'audio après une note vocale entrante.
  - `tagged` envoie uniquement de l'audio quand la réponse inclut des balises `[[tts]]`.
- `enabled` : bascule héritée (doctor migre ceci vers `auto`).
- `mode` : `"final"` (par défaut) ou `"all"` (inclut les réponses outil/bloc).
- `provider` : `"elevenlabs"`, `"openai"`, ou `"edge"` (repli automatique).
- Si `provider` n'est **pas défini**, OpenClaw préfère `openai` (si clé), puis `elevenlabs` (si clé), sinon `edge`.
- `summaryModel` : modèle économique optionnel pour résumé auto ; par défaut `agents.defaults.model.primary`.
  - Accepte `provider/model` ou un alias de modèle configuré.
- `modelOverrides` : permet au modèle d'émettre des directives TTS (activé par défaut).
- `maxTextLength` : plafond dur pour entrée TTS (caractères). `/tts audio` échoue si dépassé.
- `timeoutMs` : délai de requête (ms).
- `prefsPath` : remplace le chemin JSON de préférences locales (fournisseur/limite/résumé).
- Les valeurs `apiKey` se replient sur les variables d'env (`ELEVENLABS_API_KEY`/`XI_API_KEY`, `OPENAI_API_KEY`).
- `elevenlabs.baseUrl` : remplace l'URL de base de l'API ElevenLabs.
- `elevenlabs.voiceSettings` :
  - `stability`, `similarityBoost`, `style` : `0..1`
  - `useSpeakerBoost` : `true|false`
  - `speed` : `0.5..2.0` (1.0 = normal)
- `elevenlabs.applyTextNormalization` : `auto|on|off`
- `elevenlabs.languageCode` : ISO 639-1 à 2 lettres (par ex., `en`, `de`)
- `elevenlabs.seed` : entier `0..4294967295` (déterminisme best-effort)
- `edge.enabled` : permet l'utilisation d'Edge TTS (par défaut `true` ; pas de clé API).
- `edge.voice` : nom de voix neuronale Edge (par ex., `en-US-MichelleNeural`).
- `edge.lang` : code de langue (par ex., `en-US`).
- `edge.outputFormat` : format de sortie Edge (par ex., `audio-24khz-48kbitrate-mono-mp3`).
  - Voir les formats de sortie Microsoft Speech pour les valeurs valides ; tous les formats ne sont pas supportés par Edge.
- `edge.rate` / `edge.pitch` / `edge.volume` : chaînes de pourcentage (par ex., `+10%`, `-5%`).
- `edge.saveSubtitles` : écrit les sous-titres JSON à côté du fichier audio.
- `edge.proxy` : URL proxy pour les requêtes Edge TTS.
- `edge.timeoutMs` : remplacement du délai de requête (ms).

## Remplacements pilotés par modèle (activé par défaut)

Par défaut, le modèle **peut** émettre des directives TTS pour une seule réponse. Quand `messages.tts.auto` est `tagged`, ces directives sont requises pour déclencher l'audio.

Quand activé, le modèle peut émettre des directives `[[tts:...]]` pour remplacer la voix pour une seule réponse, plus un bloc optionnel `[[tts:text]]...[[/tts:text]]` pour fournir des balises expressives (rires, indices de chant, etc.) qui devraient seulement apparaître dans l'audio.

Exemple de charge utile de réponse :

```
Voilà pour vous.

[[tts:provider=elevenlabs voiceId=pMsXgVXv3BLzUgSXRplE model=eleven_v3 speed=1.1]]
[[tts:text]](rires) Relisez la chanson une fois de plus.[[/tts:text]]
```

Clés de directive disponibles (quand activé) :

- `provider` (`openai` | `elevenlabs` | `edge`)
- `voice` (voix OpenAI) ou `voiceId` (ElevenLabs)
- `model` (modèle TTS OpenAI ou id de modèle ElevenLabs)
- `stability`, `similarityBoost`, `style`, `speed`, `useSpeakerBoost`
- `applyTextNormalization` (`auto|on|off`)
- `languageCode` (ISO 639-1)
- `seed`

Désactiver tous les remplacements de modèle :

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

Liste d'autorisation optionnelle (désactiver des remplacements spécifiques tout en gardant les balises activées) :

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

Les commandes slash écrivent des remplacements locaux dans `prefsPath` (par défaut : `~/.openclaw/settings/tts.json`, remplacer avec `OPENCLAW_TTS_PREFS` ou `messages.tts.prefsPath`).

Champs stockés :

- `enabled`
- `provider`
- `maxLength` (seuil de résumé ; par défaut 1500 caractères)
- `summarize` (par défaut `true`)

Ceux-ci remplacent `messages.tts.*` pour cet hôte.

## Formats de sortie (fixés)

- **Telegram** : Note vocale Opus (`opus_48000_64` depuis ElevenLabs, `opus` depuis OpenAI).
  - 48kHz / 64kbps est un bon compromis pour note vocale et requis pour la bulle ronde.
- **Autres canaux** : MP3 (`mp3_44100_128` depuis ElevenLabs, `mp3` depuis OpenAI).
  - 44.1kHz / 128kbps est l'équilibre par défaut pour la clarté de la parole.
- **Edge TTS** : utilise `edge.outputFormat` (par défaut `audio-24khz-48kbitrate-mono-mp3`).
  - `node-edge-tts` accepte un `outputFormat`, mais tous les formats ne sont pas disponibles depuis le service Edge.
  - Les valeurs de format de sortie suivent les formats de sortie Microsoft Speech (incluant Ogg/WebM Opus).
  - Telegram `sendVoice` accepte OGG/MP3/M4A ; utilisez OpenAI/ElevenLabs si vous avez besoin de notes vocales Opus garanties.
  - Si le format de sortie Edge configuré échoue, OpenClaw réessaie avec MP3.

Les formats OpenAI/ElevenLabs sont fixés ; Telegram attend Opus pour l'UX de note vocale.

## Comportement auto-TTS

Quand activé, OpenClaw :

- saute le TTS si la réponse contient déjà des médias ou une directive `MEDIA:`.
- saute les réponses très courtes (< 10 caractères).
- résume les longues réponses quand activé en utilisant `agents.defaults.model.primary` (ou `summaryModel`).
- attache l'audio généré à la réponse.

Si la réponse dépasse `maxLength` et le résumé est désactivé (ou pas de clé API pour le modèle de résumé), l'audio est sauté et la réponse textuelle normale est envoyée.

## Diagramme de flux

```
Réponse -> TTS activé ?
  non  -> envoyer texte
  oui -> a des médias / MEDIA: / court ?
          oui -> envoyer texte
          non  -> longueur > limite ?
                   non  -> TTS -> attacher audio
                   oui -> résumé activé ?
                            non  -> envoyer texte
                            oui -> résumer (summaryModel ou agents.defaults.model.primary)
                                      -> TTS -> attacher audio
```

## Utilisation de commande slash

Il y a une seule commande : `/tts`. Voir [Commandes slash](/fr-FR/tools/slash-commands) pour les détails d'activation.

Note Discord : `/tts` est une commande Discord intégrée, donc OpenClaw enregistre `/voice` comme commande native là. Le texte `/tts ...` fonctionne toujours.

```
/tts off
/tts always
/tts inbound
/tts tagged
/tts status
/tts provider openai
/tts limit 2000
/tts summary off
/tts audio Bonjour depuis OpenClaw
```

Notes :

- Les commandes nécessitent un expéditeur autorisé (les règles de liste d'autorisation/propriétaire s'appliquent toujours).
- `commands.text` ou l'enregistrement de commande native doit être activé.
- `off|always|inbound|tagged` sont des bascules par session (`/tts on` est un alias pour `/tts always`).
- `limit` et `summary` sont stockés dans les préférences locales, pas la config principale.
- `/tts audio` génère une réponse audio ponctuelle (n'active pas TTS).

## Outil d'agent

L'outil `tts` convertit le texte en parole et retourne un chemin `MEDIA:`. Quand le résultat est compatible Telegram, l'outil inclut `[[audio_as_voice]]` donc Telegram envoie une bulle vocale.

## RPC de la Passerelle

Méthodes de la Passerelle :

- `tts.status`
- `tts.enable`
- `tts.disable`
- `tts.convert`
- `tts.setProvider`
- `tts.providers`
