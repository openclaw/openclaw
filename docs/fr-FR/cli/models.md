---
summary: "Référence CLI pour `openclaw models` (status/list/set/scan, alias, solutions de secours, auth)"
read_when:
  - Vous voulez changer les modèles par défaut ou voir le statut d'auth du fournisseur
  - Vous voulez scanner les modèles/fournisseurs disponibles et déboguer les profils d'auth
title: "models"
---

# `openclaw models`

Découverte de modèle, scan et configuration (modèle par défaut, solutions de secours, profils d'auth).

Connexe :

- Fournisseurs + modèles : [Modèles](/fr-FR/providers/models)
- Configuration d'auth fournisseur : [Démarrage](/fr-FR/start/getting-started)

## Commandes courantes

```bash
openclaw models status
openclaw models list
openclaw models set <model-or-alias>
openclaw models scan
```

`openclaw models status` affiche les valeurs par défaut/solutions de secours résolues plus un aperçu d'auth.
Quand les instantanés d'utilisation du fournisseur sont disponibles, la section de statut OAuth/token inclut les en-têtes d'utilisation du fournisseur.
Ajoutez `--probe` pour exécuter des sondes d'auth live contre chaque profil de fournisseur configuré.
Les sondes sont de vraies requêtes (peuvent consommer des tokens et déclencher des limites de taux).
Utilisez `--agent <id>` pour inspecter l'état modèle/auth d'un agent configuré. Quand omis, la commande utilise `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR` si défini, sinon l'agent par défaut configuré.

Notes :

- `models set <model-or-alias>` accepte `provider/model` ou un alias.
- Les références de modèle sont analysées en divisant sur le **premier** `/`. Si l'ID de modèle inclut `/` (style OpenRouter), incluez le préfixe de fournisseur (exemple : `openrouter/moonshotai/kimi-k2`).
- Si vous omettez le fournisseur, OpenClaw traite l'entrée comme un alias ou un modèle pour le **fournisseur par défaut** (fonctionne uniquement quand il n'y a pas de `/` dans l'ID de modèle).

### `models status`

Options :

- `--json`
- `--plain`
- `--check` (sortie 1=expiré/manquant, 2=expirant)
- `--probe` (sonde live des profils d'auth configurés)
- `--probe-provider <name>` (sonder un fournisseur)
- `--probe-profile <id>` (répéter ou ids de profil séparés par virgule)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`
- `--agent <id>` (id d'agent configuré ; remplace `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR`)

## Alias + solutions de secours

```bash
openclaw models aliases list
openclaw models fallbacks list
```

## Profils d'auth

```bash
openclaw models auth add
openclaw models auth login --provider <id>
openclaw models auth setup-token
openclaw models auth paste-token
```

`models auth login` exécute le flux d'auth d'un plugin de fournisseur (OAuth/clé API). Utilisez `openclaw plugins list` pour voir quels fournisseurs sont installés.

Notes :

- `setup-token` demande une valeur de setup-token (générez-la avec `claude setup-token` sur n'importe quelle machine).
- `paste-token` accepte une chaîne de token générée ailleurs ou depuis l'automatisation.
