---
summary: "Transcription Deepgram pour les notes vocales entrantes"
read_when:
  - Vous souhaitez utiliser la reconnaissance vocale Deepgram pour les pièces jointes audio
  - Vous avez besoin d’un exemple de configuration Deepgram rapide
title: "Deepgram"
---

# Deepgram (Transcription audio)

Deepgram est une API de reconnaissance vocale. Dans OpenClaw, elle est utilisée pour la **transcription des audios/notes vocales entrantes** via `tools.media.audio`.

Lorsqu’elle est activée, OpenClaw téléverse le fichier audio vers Deepgram et injecte la transcription dans le pipeline de réponse (bloc `{{Transcript}}` + `[Audio]`). Ce n’est **pas du streaming** ; l’endpoint de transcription préenregistrée est utilisé.

Site web : https://deepgram.com  
Docs : https://developers.deepgram.com

## Demarrage rapide

1. Définissez votre clé API :

```
DEEPGRAM_API_KEY=dg_...
```

2. Activez le fournisseur :

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "deepgram", model: "nova-3" }],
      },
    },
  },
}
```

## Options

- `model` : identifiant du modèle Deepgram (par défaut : `nova-3`)
- `language` : indication de langue (optionnel)
- `tools.media.audio.providerOptions.deepgram.detect_language` : activer la détection de la langue (optionnel)
- `tools.media.audio.providerOptions.deepgram.punctuate` : activer la ponctuation (optionnel)
- `tools.media.audio.providerOptions.deepgram.smart_format` : activer le formatage intelligent (optionnel)

Exemple avec langue :

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "deepgram", model: "nova-3", language: "en" }],
      },
    },
  },
}
```

Exemple avec des options Deepgram :

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        providerOptions: {
          deepgram: {
            detect_language: true,
            punctuate: true,
            smart_format: true,
          },
        },
        models: [{ provider: "deepgram", model: "nova-3" }],
      },
    },
  },
}
```

## Notes

- L’authentification suit l’ordre standard des fournisseurs ; `DEEPGRAM_API_KEY` est la voie la plus simple.
- Remplacez les endpoints ou les en-têtes avec `tools.media.audio.baseUrl` et `tools.media.audio.headers` lors de l’utilisation d’un proxy.
- La sortie suit les mêmes règles audio que les autres fournisseurs (plafonds de taille, délais d’expiration, injection de la transcription).
