---
summary: "Utiliser Z.AI (modèles GLM) avec OpenClaw"
read_when:
  - Vous souhaitez utiliser les modèles Z.AI / GLM dans OpenClaw
  - Vous avez besoin d'une configuration simple ZAI_API_KEY
title: "Z.AI"
---

# Z.AI

Z.AI est la plateforme API pour les modèles **GLM**. Elle fournit des API REST pour GLM et utilise des clés API pour l'authentification. Créez votre clé API dans la console Z.AI. OpenClaw utilise le fournisseur `zai` avec une clé API Z.AI.

## Configuration CLI

```bash
openclaw onboard --auth-choice zai-api-key
# ou non-interactif
openclaw onboard --zai-api-key "$ZAI_API_KEY"
```

## Extrait de configuration

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-5" } } },
}
```

## Remarques

- Les modèles GLM sont disponibles comme `zai/<modèle>` (exemple : `zai/glm-5`).
- Voir [/fr-FR/providers/glm](/fr-FR/providers/glm) pour l'aperçu de la famille de modèles.
- Z.AI utilise l'authentification Bearer avec votre clé API.
