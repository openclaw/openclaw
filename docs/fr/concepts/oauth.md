---
summary: "OAuth dans OpenClaw : échange de jetons, stockage et modèles multi-comptes"
read_when:
  - Vous souhaitez comprendre OAuth de bout en bout dans OpenClaw
  - Vous rencontrez des problèmes d'invalidation de jetons / de déconnexion
  - Vous souhaitez des flux d’authentification setup-token ou OAuth
  - Vous souhaitez plusieurs comptes ou un routage par profil
title: "OAuth"
---

# OAuth

OpenClaw prend en charge l’« authentification par abonnement » via OAuth pour les fournisseurs qui la proposent (notamment **OpenAI Codex (ChatGPT OAuth)**). Pour les abonnements Anthropic, utilisez le flux **setup-token**. Cette page explique :

- comment fonctionne l’**échange de jetons** OAuth (PKCE)
- où les jetons sont **stockés** (et pourquoi)
- comment gérer **plusieurs comptes** (profils + remplacements par session)

OpenClaw prend également en charge des **plugins de fournisseurs** qui embarquent leurs propres flux OAuth ou par clé API. Exécutez-les via :

```bash
openclaw models auth login --provider <id>
```

## Le puits à jetons (pourquoi il existe)

Les fournisseurs OAuth émettent couramment un **nouveau jeton d’actualisation** lors des flux de connexion/actualisation. Certains fournisseurs (ou clients OAuth) peuvent invalider les anciens jetons d’actualisation lorsqu’un nouveau est émis pour le même utilisateur/la même application.

Symptôme pratique :

- vous vous connectez via OpenClaw _et_ via Claude Code / Codex CLI → l’un des deux se retrouve « déconnecté » aléatoirement plus tard

Pour réduire cela, OpenClaw traite `auth-profiles.json` comme un **puits à jetons** :

- l’exécution lit les identifiants depuis **un seul endroit**
- nous pouvons conserver plusieurs profils et les router de manière déterministe

## Stockage (où vivent les jetons)

Les secrets sont stockés **par agent** :

- Profils d’authentification (OAuth + clés API) : `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- Cache d’exécution (géré automatiquement ; ne pas modifier) : `~/.openclaw/agents/<agentId>/agent/auth.json`

Fichier hérité, import uniquement (toujours pris en charge, mais pas le stockage principal) :

- `~/.openclaw/credentials/oauth.json` (importé dans `auth-profiles.json` lors de la première utilisation)

Tout ce qui précède respecte également `$OPENCLAW_STATE_DIR` (remplacement du répertoire d’état). Référence complète : [/gateway/configuration](/gateway/configuration#auth-storage-oauth--api-keys)

## Setup-token Anthropic (authentification par abonnement)

Exécutez `claude setup-token` sur n’importe quelle machine, puis collez-le dans OpenClaw :

```bash
openclaw models auth setup-token --provider anthropic
```

Si vous avez généré le jeton ailleurs, collez-le manuellement :

```bash
openclaw models auth paste-token --provider anthropic
```

Vérifier :

```bash
openclaw models status
```

## Échange OAuth (comment fonctionne la connexion)

Les flux de connexion interactifs d’OpenClaw sont implémentés dans `@mariozechner/pi-ai` et reliés aux assistants/commandes.

### Setup-token Anthropic (Claude Pro/Max)

Forme du flux :

1. exécuter `claude setup-token`
2. coller le jeton dans OpenClaw
3. stocker comme profil d’authentification par jeton (sans actualisation)

Le chemin de l’assistant est `openclaw onboard` → choix d’authentification `setup-token` (Anthropic).

### OpenAI Codex (ChatGPT OAuth)

Forme du flux (PKCE) :

1. générer le vérificateur/défi PKCE + un `state` aléatoire
2. ouvrir `https://auth.openai.com/oauth/authorize?...`
3. tenter de capturer le rappel sur `http://127.0.0.1:1455/auth/callback`
4. si le rappel ne peut pas s’attacher (ou si vous êtes distant/sans interface), collez l’URL de redirection/le code
5. échanger à `https://auth.openai.com/oauth/token`
6. extraire `accountId` depuis le jeton d’accès et stocker `{ access, refresh, expires, accountId }`

Le chemin de l’assistant est `openclaw onboard` → choix d’authentification `openai-codex`.

## Actualisation + expiration

Les profils stockent un horodatage `expires`.

À l’exécution :

- si `expires` est dans le futur → utiliser le jeton d’accès stocké
- s’il est expiré → actualiser (sous verrou de fichier) et écraser les identifiants stockés

Le flux d’actualisation est automatique ; vous n’avez généralement pas besoin de gérer les jetons manuellement.

## Comptes multiples (profils) + routage

Deux modèles :

### 1. Préféré : agents séparés

Si vous voulez que « personnel » et « travail » n’interagissent jamais, utilisez des agents isolés (sessions + identifiants + espace de travail séparés) :

```bash
openclaw agents add work
openclaw agents add personal
```

Configurez ensuite l’authentification par agent (assistant) et routez les discussions vers le bon agent.

### 2. Avancé : plusieurs profils dans un seul agent

`auth-profiles.json` prend en charge plusieurs identifiants de profil pour un même fournisseur.

Choisissez quel profil est utilisé :

- globalement via l’ordre de configuration (`auth.order`)
- par session via `/model ...@<profileId>`

Exemple (remplacement par session) :

- `/model Opus@anthropic:work`

Comment voir quels identifiants de profil existent :

- `openclaw channels list --json` (affiche `auth[]`)

Documentation connexe :

- [/concepts/model-failover](/concepts/model-failover) (règles de rotation + temporisation)
- [/tools/slash-commands](/tools/slash-commands) (surface des commandes)
