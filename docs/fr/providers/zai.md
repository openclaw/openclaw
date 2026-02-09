---
summary: "Utiliser Z.AI (modeles GLM) avec OpenClaw"
read_when:
  - Vous souhaitez des modeles Z.AI / GLM dans OpenClaw
  - Vous avez besoin d'une configuration simple de ZAI_API_KEY
title: "Z.AI"
---

# Z.AI

Z.AI est la plateforme API pour les modeles **GLM**. Elle fournit des API REST pour GLM et utilise des cles API
pour l'authentification. Creez votre cle API dans la console Z.AI. OpenClaw utilise le fournisseur `zai`
avec une cle API Z.AI.

## Configuration CLI

```bash
openclaw onboard --auth-choice zai-api-key
# or non-interactive
openclaw onboard --zai-api-key "$ZAI_API_KEY"
```

## Extrait de configuration

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
}
```

## Notes

- Les modeles GLM sont disponibles sous la forme `zai/<model>` (exemple : `zai/glm-4.7`).
- Voir [/providers/glm](/providers/glm) pour la vue d'ensemble de la famille de modeles.
- Z.AI utilise l'authentification Bearer avec votre cle API.
