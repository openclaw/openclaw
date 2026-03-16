---
summary: "Utiliser OpenCode Zen (modèles sélectionnés) avec OpenClaw"
read_when:
  - Vous souhaitez OpenCode Zen pour l'accès aux modèles
  - Vous voulez une liste sélectionnée de modèles adaptés au codage
title: "OpenCode Zen"
---

# OpenCode Zen

OpenCode Zen est une **liste sélectionnée de modèles** recommandés par l'équipe OpenCode pour les agents de codage. C'est un chemin d'accès aux modèles hébergé optionnel qui utilise une clé API et le fournisseur `opencode`. Zen est actuellement en bêta.

## Configuration CLI

```bash
openclaw onboard --auth-choice opencode-zen
# ou non-interactif
openclaw onboard --opencode-zen-api-key "$OPENCODE_API_KEY"
```

## Extrait de configuration

```json5
{
  env: { OPENCODE_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

## Remarques

- `OPENCODE_ZEN_API_KEY` est également supporté.
- Vous vous connectez à Zen, ajoutez des informations de facturation et copiez votre clé API.
- OpenCode Zen facture par requête ; consultez le tableau de bord OpenCode pour les détails.
