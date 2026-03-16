---
summary: "Configuration avancée et flux de travail de développement pour OpenClaw"
read_when:
  - Configuration d'une nouvelle machine
  - Vous voulez "le plus récent" sans casser votre configuration personnelle
title: "Configuration"
---

# Configuration

<Note>
Si vous configurez pour la première fois, commencez par [Premiers pas](/fr-FR/start/getting-started).
Pour les détails de l'assistant, consultez [Assistant d'intégration](/fr-FR/start/wizard).
</Note>

Dernière mise à jour : 2026-01-01

## Résumé

- **La personnalisation vit en dehors du dépôt :** `~/.openclaw/workspace` (espace de travail) + `~/.openclaw/openclaw.json` (configuration).
- **Flux de travail stable :** installez l'application macOS ; laissez-la exécuter la passerelle intégrée.
- **Flux de travail de pointe :** exécutez la passerelle vous-même via `pnpm gateway:watch`, puis laissez l'application macOS s'attacher en mode local.

## Prérequis (depuis la source)

- Node `>=22`
- `pnpm`
- Docker (optionnel ; uniquement pour la configuration conteneurisée/e2e — consultez [Docker](/fr-FR/install/docker))

## Stratégie de personnalisation (pour que les mises à jour ne fassent pas mal)

Si vous voulez "100% adapté à moi" _et_ des mises à jour faciles, gardez votre personnalisation dans :

- **Configuration :** `~/.openclaw/openclaw.json` (JSON/JSON5-ish)
- **Espace de travail :** `~/.openclaw/workspace` (compétences, prompts, mémoires ; faites-en un dépôt git privé)

Initialisez une fois :

```bash
openclaw setup
```

Depuis l'intérieur de ce dépôt, utilisez le point d'entrée CLI local :

```bash
openclaw setup
```

Si vous n'avez pas encore d'installation globale, exécutez-le via `pnpm openclaw setup`.

## Exécuter la passerelle depuis ce dépôt

Après `pnpm build`, vous pouvez exécuter la CLI packagée directement :

```bash
node openclaw.mjs gateway --port 18789 --verbose
```

## Flux de travail stable (application macOS d'abord)

1. Installez et lancez **OpenClaw.app** (barre de menus).
2. Complétez la liste de contrôle d'intégration/permissions (invites TCC).
3. Assurez-vous que la passerelle est **locale** et en cours d'exécution (l'application la gère).
4. Liez les surfaces (exemple : WhatsApp) :

```bash
openclaw channels login
```

5. Vérification de cohérence :

```bash
openclaw health
```

Si l'intégration n'est pas disponible dans votre build :

- Exécutez `openclaw setup`, puis `openclaw channels login`, puis démarrez la passerelle manuellement (`openclaw gateway`).

## Flux de travail de pointe (passerelle dans un terminal)

Objectif : travailler sur la passerelle TypeScript, obtenir le rechargement à chaud, garder l'interface de l'application macOS attachée.

### 0) (Optionnel) Exécuter aussi l'application macOS depuis la source

Si vous voulez aussi l'application macOS sur la pointe :

```bash
./scripts/restart-mac.sh
```

### 1) Démarrer la passerelle de développement

```bash
pnpm install
pnpm gateway:watch
```

`gateway:watch` exécute la passerelle en mode surveillance et recharge lors des changements TypeScript.

### 2) Pointer l'application macOS vers votre passerelle en cours d'exécution

Dans **OpenClaw.app** :

- Mode de connexion : **Local**
  L'application s'attachera à la passerelle en cours d'exécution sur le port configuré.

### 3) Vérifier

- Le statut de la passerelle dans l'application devrait indiquer **"Utilisation de la passerelle existante…"**
- Ou via CLI :

```bash
openclaw health
```

### Pièges courants

- **Mauvais port :** La passerelle WS est par défaut sur `ws://127.0.0.1:18789` ; gardez l'application + CLI sur le même port.
- **Où vit l'état :**
  - Identifiants : `~/.openclaw/credentials/`
  - Sessions : `~/.openclaw/agents/<agentId>/sessions/`
  - Journaux : `/tmp/openclaw/`

## Carte de stockage des identifiants

Utilisez ceci lors du débogage de l'authentification ou de la décision de ce qu'il faut sauvegarder :

- **WhatsApp** : `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
- **Token de bot Telegram** : config/env ou `channels.telegram.tokenFile`
- **Token de bot Discord** : config/env (fichier de token pas encore pris en charge)
- **Tokens Slack** : config/env (`channels.slack.*`)
- **Listes d'autorisation d'appairage** : `~/.openclaw/credentials/<channel>-allowFrom.json`
- **Profils d'authentification de modèle** : `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- **Import OAuth ancien** : `~/.openclaw/credentials/oauth.json`
  Plus de détails : [Sécurité](/fr-FR/gateway/security#credential-storage-map).

## Mise à jour (sans détruire votre configuration)

- Gardez `~/.openclaw/workspace` et `~/.openclaw/` comme "vos affaires" ; ne mettez pas de prompts/configuration personnels dans le dépôt `openclaw`.
- Mise à jour de la source : `git pull` + `pnpm install` (quand le fichier de verrouillage a changé) + continuez à utiliser `pnpm gateway:watch`.

## Linux (service utilisateur systemd)

Les installations Linux utilisent un service **utilisateur** systemd. Par défaut, systemd arrête les services utilisateur lors de la déconnexion/inactivité, ce qui tue la passerelle. L'intégration tente d'activer le maintien pour vous (peut demander sudo). Si c'est toujours désactivé, exécutez :

```bash
sudo loginctl enable-linger $USER
```

Pour les serveurs toujours actifs ou multi-utilisateurs, envisagez un service **système** au lieu d'un service utilisateur (pas de maintien nécessaire). Consultez [Guide de la passerelle](/fr-FR/gateway) pour les notes systemd.

## Documentation connexe

- [Guide de la passerelle](/fr-FR/gateway) (indicateurs, supervision, ports)
- [Configuration de la passerelle](/fr-FR/gateway/configuration) (schéma de configuration + exemples)
- [Discord](/fr-FR/channels/discord) et [Telegram](/fr-FR/channels/telegram) (balises de réponse + paramètres replyToMode)
- [Configuration d'assistant OpenClaw](/fr-FR/start/openclaw)
- [Application macOS](/fr-FR/platforms/macos) (cycle de vie de la passerelle)
