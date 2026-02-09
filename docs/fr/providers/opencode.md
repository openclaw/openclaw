---
summary: "Utiliser OpenCode Zen (modeles selectionnes) avec OpenClaw"
read_when:
  - Vous voulez OpenCode Zen pour l'acces aux modeles
  - Vous voulez une liste selectionnee de modeles adaptes au code
title: "OpenCode Zen"
---

# OpenCode Zen

OpenCode Zen est une **liste selectionnee de modeles** recommandes par l'equipe OpenCode pour les agents de code.
Il s'agit d'une voie d'acces hebergee et optionnelle aux modeles qui utilise une cle API et le fournisseur `opencode`.
Zen est actuellement en beta.

## Configuration du CLI

```bash
openclaw onboard --auth-choice opencode-zen
# or non-interactive
openclaw onboard --opencode-zen-api-key "$OPENCODE_API_KEY"
```

## Extrait de configuration

```json5
{
  env: { OPENCODE_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

## Notes

- `OPENCODE_ZEN_API_KEY` est egalement pris en charge.
- Vous vous connectez a Zen, ajoutez des informations de facturation et copiez votre cle API.
- OpenCode Zen facture par requete ; consultez le tableau de bord OpenCode pour plus de details.
