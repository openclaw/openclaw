---
summary: "Utiliser l’OAuth Qwen (offre gratuite) dans OpenClaw"
read_when:
  - Vous souhaitez utiliser Qwen avec OpenClaw
  - Vous souhaitez un accès OAuth gratuit à Qwen Coder
title: "Qwen"
---

# Qwen

Qwen propose un flux OAuth gratuit pour les modèles Qwen Coder et Qwen Vision
(2 000 requêtes/jour, sous réserve des limites de débit de Qwen).

## Activer le plugin

```bash
openclaw plugins enable qwen-portal-auth
```

Redémarrez la Gateway (passerelle) après l’activation.

## S’authentifier

```bash
openclaw models auth login --provider qwen-portal --set-default
```

Cela exécute le flux OAuth par code d’appareil de Qwen et écrit une entrée de fournisseur dans votre
`models.json` (ainsi qu’un alias `qwen` pour un basculement rapide).

## ID de modèles

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

Changer de modèle avec :

```bash
openclaw models set qwen-portal/coder-model
```

## Réutiliser la connexion Qwen Code CLI

Si vous vous êtes déjà connecté avec le Qwen Code CLI, OpenClaw synchronisera les identifiants
depuis `~/.qwen/oauth_creds.json` lors du chargement du magasin d’authentification. Vous avez toujours besoin d’une
entrée `models.providers.qwen-portal` (utilisez la commande de connexion ci-dessus pour en créer une).

## Notes

- Les jetons se renouvellent automatiquement ; relancez la commande de connexion si le renouvellement échoue ou si l’accès est révoqué.
- URL de base par défaut : `https://portal.qwen.ai/v1` (remplacez-la avec
  `models.providers.qwen-portal.baseUrl` si Qwen fournit un point de terminaison différent).
- Consultez [Model providers](/concepts/model-providers) pour les règles applicables à l’ensemble des fournisseurs.
