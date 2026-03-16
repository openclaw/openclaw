---
summary: "Utilisez Qwen OAuth (niveau gratuit) dans OpenClaw"
read_when:
  - Vous voulez utiliser Qwen avec OpenClaw
  - Vous voulez l'accès OAuth gratuit à Qwen Coder
title: "Qwen"
---

# Qwen

Qwen fournit un flux OAuth gratuit pour les modèles Qwen Coder et Qwen Vision (2 000 requêtes/jour, soumis aux limites de débit Qwen).

## Activer le plugin

```bash
openclaw plugins enable qwen-portal-auth
```

Redémarrez la Passerelle après activation.

## Authentification

```bash
openclaw models auth login --provider qwen-portal --set-default
```

Ceci exécute le flux OAuth device-code Qwen et écrit une entrée de fournisseur dans votre `models.json` (plus un alias `qwen` pour basculement rapide).

## IDs de modèle

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

Basculer les modèles avec :

```bash
openclaw models set qwen-portal/coder-model
```

## Réutiliser la connexion Qwen Code CLI

Si vous vous êtes déjà connecté avec la CLI Qwen Code, OpenClaw synchronisera les identifiants depuis `~/.qwen/oauth_creds.json` quand il charge le magasin auth. Vous avez toujours besoin d'une entrée `models.providers.qwen-portal` (utilisez la commande de connexion ci-dessus pour en créer une).

## Notes

- Les tokens se rafraîchissent automatiquement ; réexécutez la commande de connexion si le rafraîchissement échoue ou l'accès est révoqué.
- URL de base par défaut : `https://portal.qwen.ai/v1` (remplacer avec `models.providers.qwen-portal.baseUrl` si Qwen fournit un point de terminaison différent).
- Voir [Fournisseurs de modèles](/fr-FR/concepts/model-providers) pour les règles à l'échelle du fournisseur.
