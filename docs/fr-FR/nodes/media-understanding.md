---
summary: "Compréhension image/audio/video entrante (optionnelle) avec fallbacks provider + CLI"
read_when:
  - Design ou refactoring compréhension média
  - Ajustement prétraitement audio/video/image entrant
title: "Compréhension Média"
---

# Compréhension Média (Entrant)

OpenClaw peut **résumer média entrant** (image/audio/video) avant exécution pipeline réponse. Auto-détecte quand outils locaux ou clés provider disponibles, et peut être désactivé ou personnalisé. Si compréhension désactivée, modèles reçoivent toujours fichiers/URLs originaux comme d'habitude.

## Objectifs

- Optionnel : pré-digérer média entrant vers texte court pour routing plus rapide + meilleur parsing commande.
- Préserver livraison média originale au modèle (toujours).
- Supporter **APIs provider** et **fallbacks CLI**.
- Permettre modèles multiples avec fallback ordonné (erreur/taille/timeout).

## Comportement High-Level

1. Collecter pièces jointes entrantes (`MediaPaths`, `MediaUrls`, `MediaTypes`).
2. Pour chaque capacité activée (image/audio/video), sélectionner attachments per politique (défaut : **premier**).
3. Choisir première entrée modèle éligible (taille + capacité + auth).
4. Si modèle échoue ou média trop large, **fall back vers entrée suivante**.
5. Sur succès :
   - `Body` devient bloc `[Image]`, `[Audio]` ou `[Video]`.
   - Audio définit `{{Transcript}}` ; parsing commande utilise texte légende quand présent, sinon transcript.
   - Légendes préservées comme `User text:` dans bloc.

Si compréhension échoue ou désactivée, **flux réponse continue** avec body + attachments originaux.

## Aperçu Config

`tools.media` supporte **modèles partagés** plus overrides per-capacité :

- `tools.media.models` : liste modèle partagée (utiliser `capabilities` pour gater).
- `tools.media.image` / `tools.media.audio` / `tools.media.video` :
  - défauts (`prompt`, `maxChars`, `maxBytes`, `timeoutSeconds`, `language`)
  - overrides provider (`baseUrl`, `headers`, `providerOptions`)
  - options audio Deepgram via `tools.media.audio.providerOptions.deepgram`
  - **liste `models` per-capacité** optionnelle (préférée avant modèles partagés)
  - politique `attachments` (`mode`, `maxAttachments`, `prefer`)
  - `scope` (gating optionnel par canal/chatType/session key)
- `tools.media.concurrency` : max runs capacité concurrent (défaut **2**).

```json5
{
  tools: {
    media: {
      models: [{ provider: "openai", model: "gpt-4o-mini", capabilities: ["image", "audio"] }],
      image: {
        enabled: true,
        maxBytes: 5242880,
      },
      audio: {
        enabled: true,
        maxBytes: 20971520,
      },
    },
  },
}
```

Voir aussi :

- [Audio](/fr-FR/nodes/audio)
- [Images](/fr-FR/nodes/images)
- [Configuration](/fr-FR/gateway/configuration)
