---
summary: "Aperçu de la famille de modèles GLM + comment l'utiliser dans OpenClaw"
read_when:
  - Vous souhaitez utiliser les modèles GLM dans OpenClaw
  - Vous avez besoin de la convention de nommage et de la configuration
title: "Modèles GLM"
---

# Modèles GLM

GLM est une **famille de modèles** (pas une entreprise) disponible via la plateforme Z.AI. Dans OpenClaw, les modèles GLM sont accessibles via le fournisseur `zai` et des ID de modèles comme `zai/glm-5`.

## Configuration CLI

```bash
openclaw onboard --auth-choice zai-api-key
```

## Extrait de configuration

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-5" } } },
}
```

## Remarques

- Les versions GLM et la disponibilité peuvent changer ; consultez la documentation de Z.AI pour les dernières informations.
- Les ID de modèles incluent par exemple `glm-5`, `glm-4.7` et `glm-4.6`.
- Pour les détails du fournisseur, voir [/fr-FR/providers/zai](/fr-FR/providers/zai).
