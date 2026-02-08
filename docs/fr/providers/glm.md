---
summary: "Aperçu de la famille de modèles GLM + comment l’utiliser dans OpenClaw"
read_when:
  - Vous voulez des modèles GLM dans OpenClaw
  - Vous avez besoin de la convention de nommage des modèles et de la configuration
title: "Modèles GLM"
x-i18n:
  source_path: providers/glm.md
  source_hash: 2d7b457f033f26f2
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T07:02:28Z
---

# Modèles GLM

GLM est une **famille de modèles** (pas une entreprise) disponible via la plateforme Z.AI. Dans OpenClaw, les modèles GLM
sont accessibles via le fournisseur `zai` et des identifiants de modèle comme `zai/glm-4.7`.

## Configuration CLI

```bash
openclaw onboard --auth-choice zai-api-key
```

## Extrait de configuration

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
}
```

## Notes

- Les versions et la disponibilité de GLM peuvent changer ; consultez la documentation de Z.AI pour les informations les plus récentes.
- Des exemples d’identifiants de modèle incluent `glm-4.7` et `glm-4.6`.
- Pour les détails du fournisseur, voir [/providers/zai](/providers/zai).
