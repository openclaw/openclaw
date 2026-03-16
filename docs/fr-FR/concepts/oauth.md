---
summary: "OAuth dans OpenClaw : échange de jetons, stockage et modèles multi-comptes"
read_when:
  - Vous voulez comprendre OAuth d'OpenClaw de bout en bout
  - Vous rencontrez des problèmes d'invalidation de jeton / déconnexion
  - Vous voulez des flux d'authentification setup-token ou OAuth
  - Vous voulez plusieurs comptes ou routage de profil
title: "OAuth"
---

# OAuth

OpenClaw supporte "l'authentification par abonnement" via OAuth pour les fournisseurs qui l'offrent (notamment **OpenAI Codex (OAuth ChatGPT)**). Pour les abonnements Anthropic, utilisez le flux **setup-token**. Cette page explique :

- comment **l'échange de jetons** OAuth fonctionne (PKCE)
- où les jetons sont **stockés** (et pourquoi)
- comment gérer **plusieurs comptes** (profils + remplacements par session)

OpenClaw supporte aussi les **plugins de fournisseur** qui livrent leurs propres flux OAuth ou de clé API.
Exécutez-les via :

```bash
openclaw models auth login --provider <id>
```

## Le collecteur de jetons (pourquoi il existe)

Les fournisseurs OAuth émettent couramment un **nouveau jeton de rafraîchissement** lors des flux de connexion/rafraîchissement. Certains fournisseurs (ou clients OAuth) peuvent invalider les anciens jetons de rafraîchissement quand un nouveau est émis pour le même utilisateur/app.

Symptôme pratique :

- vous vous connectez via OpenClaw _et_ via Claude Code / Codex CLI → l'un d'eux est aléatoirement "déconnecté" plus tard

Pour réduire cela, OpenClaw traite `auth-profiles.json` comme un **collecteur de jetons** :

- l'environnement d'exécution lit les identifiants depuis **un seul endroit**
- nous pouvons garder plusieurs profils et les router de manière déterministe

## Stockage (où vivent les jetons)

Les secrets sont stockés **par agent** :

- Profils d'authentification (OAuth + clés API) : `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- Cache d'exécution (géré automatiquement ; ne pas éditer) : `~/.openclaw/agents/<agentId>/agent/auth.json`

Fichier hérité import uniquement (toujours supporté, mais pas le magasin principal) :

- `~/.openclaw/credentials/oauth.json` (importé dans `auth-profiles.json` à la première utilisation)

Tous les éléments ci-dessus respectent aussi `$OPENCLAW_STATE_DIR` (remplacement de répertoire d'état). Référence complète : [/gateway/configuration](/fr-FR/gateway/configuration#auth-storage-oauth--api-keys)

## Setup-token Anthropic (authentification par abonnement)

Exécutez `claude setup-token` sur n'importe quelle machine, puis collez-le dans OpenClaw :

```bash
openclaw models auth setup-token --provider anthropic
```

Si vous avez généré le jeton ailleurs, collez-le manuellement :

```bash
openclaw models auth paste-token --provider anthropic
```

Vérifiez :

```bash
openclaw models status
```

## Échange OAuth (comment fonctionne la connexion)

Les flux de connexion interactifs d'OpenClaw sont implémentés dans `@mariozechner/pi-ai` et câblés dans les assistants/commandes.

### Setup-token Anthropic (Claude Pro/Max)

Forme du flux :

1. exécutez `claude setup-token`
2. collez le jeton dans OpenClaw
3. stockez comme profil d'authentification par jeton (pas de rafraîchissement)

Le chemin d'assistant est `openclaw onboard` → choix d'authentification `setup-token` (Anthropic).

### OpenAI Codex (OAuth ChatGPT)

Forme du flux (PKCE) :

1. générez vérificateur/défi PKCE + `state` aléatoire
2. ouvrez `https://auth.openai.com/oauth/authorize?...`
3. essayez de capturer le callback sur `http://127.0.0.1:1455/auth/callback`
4. si le callback ne peut pas se lier (ou vous êtes distant/sans tête), collez l'URL/code de redirection
5. échangez à `https://auth.openai.com/oauth/token`
6. extrayez `accountId` du jeton d'accès et stockez `{ access, refresh, expires, accountId }`

Le chemin d'assistant est `openclaw onboard` → choix d'authentification `openai-codex`.

## Rafraîchissement + expiration

Les profils stockent un timestamp `expires`.

À l'exécution :

- si `expires` est dans le futur → utilisez le jeton d'accès stocké
- si expiré → rafraîchissez (sous un verrou de fichier) et écrasez les identifiants stockés

Le flux de rafraîchissement est automatique ; vous n'avez généralement pas besoin de gérer les jetons manuellement.

## Plusieurs comptes (profils) + routage

Deux modèles :

### 1) Préféré : agents séparés

Si vous voulez que "personnel" et "travail" n'interagissent jamais, utilisez des agents isolés (sessions + identifiants + espace de travail séparés) :

```bash
openclaw agents add work
openclaw agents add personal
```

Puis configurez l'authentification par agent (assistant) et routez les chats vers le bon agent.

### 2) Avancé : plusieurs profils dans un agent

`auth-profiles.json` supporte plusieurs IDs de profil pour le même fournisseur.

Choisissez quel profil est utilisé :

- globalement via l'ordre de configuration (`auth.order`)
- par session via `/model ...@<profileId>`

Exemple (remplacement de session) :

- `/model Opus@anthropic:work`

Comment voir quels IDs de profil existent :

- `openclaw channels list --json` (montre `auth[]`)

Documents associés :

- [/concepts/model-failover](/fr-FR/concepts/model-failover) (règles de rotation + cooldown)
- [/tools/slash-commands](/fr-FR/tools/slash-commands) (surface de commande)
