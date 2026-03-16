---
summary: "Transcription Deepgram pour notes vocales entrantes"
read_when:
  - Vous voulez la parole-en-texte Deepgram pour pièces jointes audio
  - Vous avez besoin d'un exemple de config Deepgram rapide
title: "Deepgram"
---

# Deepgram (Transcription Audio)

Deepgram est une API parole-en-texte. Dans OpenClaw elle est utilisée pour **la transcription de notes audio/vocales entrantes** via `tools.media.audio`.

Quand activé, OpenClaw télécharge le fichier audio vers Deepgram et injecte la transcription dans le pipeline de réponse (`{{Transcript}}` + bloc `[Audio]`). Ce n'est **pas du streaming** ; il utilise le point de terminaison de transcription pré-enregistrée.

Site web : [https://deepgram.com](https://deepgram.com)  
Docs : [https://developers.deepgram.com](https://developers.deepgram.com)

## Démarrage rapide

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

- `model` : id de modèle Deepgram (par défaut : `nova-3`)
- `language` : indice de langue (optionnel)
- `tools.media.audio.providerOptions.deepgram.detect_language` : activer détection de langue (optionnel)
- `tools.media.audio.providerOptions.deepgram.punctuate` : activer ponctuation (optionnel)
- `tools.media.audio.providerOptions.deepgram.smart_format` : activer formatage intelligent (optionnel)

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

Exemple avec options Deepgram :

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

- L'authentification suit l'ordre auth de fournisseur standard ; `DEEPGRAM_API_KEY` est le chemin le plus simple.
- Remplacez les points de terminaison ou en-têtes avec `tools.media.audio.baseUrl` et `tools.media.audio.headers` quand vous utilisez un proxy.
- La sortie suit les mêmes règles audio que d'autres fournisseurs (plafonds de taille, timeouts, injection de transcription).
