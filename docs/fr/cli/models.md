---
summary: "Référence CLI pour `openclaw models` (status/list/set/scan, alias, solutions de repli, auth)"
read_when:
  - Vous souhaitez changer les modèles par défaut ou consulter l’état d’authentification des fournisseurs
  - Vous souhaitez analyser les modèles/fournisseurs disponibles et déboguer les profils d’authentification
title: "modèles"
---

# `openclaw models`

Découverte, analyse et configuration des modèles (modèle par défaut, solutions de repli, profils d’authentification).

Liens connexes :

- Fournisseurs + modèles : [Models](/providers/models)
- Configuration de l’authentification des fournisseurs : [Getting started](/start/getting-started)

## Commandes courantes

```bash
openclaw models status
openclaw models list
openclaw models set <model-or-alias>
openclaw models scan
```

`openclaw models status` affiche le défaut résolu/les solutions de repli ainsi qu’une vue d’ensemble de l’authentification.
Lorsque des instantanés d’utilisation des fournisseurs sont disponibles, la section d’état OAuth/token inclut
les en-têtes d’utilisation des fournisseurs.
Ajoutez `--probe` pour exécuter des sondes d’authentification en direct contre chaque profil de fournisseur configuré.
Les sondes sont de vraies requêtes (peuvent consommer des tokens et déclencher des limites de débit).
Utilisez `--agent <id>` pour inspecter l’état modèle/authentification d’un agent configuré. En cas d’omission,
la commande utilise `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR` s’ils sont définis, sinon
l’agent par défaut configuré.

Remarques :

- `models set <model-or-alias>` accepte `provider/model` ou un alias.
- Les références de modèle sont analysées en scindant sur le **premier** `/`. Si l’ID du modèle inclut `/` (style OpenRouter), incluez le préfixe du fournisseur (exemple : `openrouter/moonshotai/kimi-k2`).
- Si vous omettez le fournisseur, OpenClaw traite l’entrée comme un alias ou un modèle pour le **fournisseur par défaut** (fonctionne uniquement lorsqu’il n’y a pas de `/` dans l’ID du modèle).

### `models status`

Options :

- `--json`
- `--plain`
- `--check` (sortie 1=expiré/manquant, 2=expirant)
- `--probe` (sonde en direct des profils d’authentification configurés)
- `--probe-provider <name>` (sonder un fournisseur)
- `--probe-profile <id>` (répéter ou identifiants de profil séparés par des virgules)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`
- `--agent <id>` (identifiant d’agent configuré ; remplace `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR`)

## Alias + replis

```bash
openclaw models aliases list
openclaw models fallbacks list
```

## Profils d’authentification

```bash
openclaw models auth add
openclaw models auth login --provider <id>
openclaw models auth setup-token
openclaw models auth paste-token
```

`models auth login` exécute le flux d’authentification d’un plugin fournisseur (OAuth/clé API). Utilisez
`openclaw plugins list` pour voir quels fournisseurs sont installés.

Remarques :

- `setup-token` demande une valeur de setup-token (générez-la avec `claude setup-token` sur n’importe quelle machine).
- `paste-token` accepte une chaîne de token générée ailleurs ou via une automatisation.
