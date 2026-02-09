---
summary: "Configuration avancee et workflows de developpement pour OpenClaw"
read_when:
  - Configuration d'une nouvelle machine
  - Vous voulez le « dernier cri » sans casser votre configuration personnelle
title: "Configuration"
---

# Configuration

<Note>
Si vous configurez pour la premiere fois, commencez par [Premiers pas](/start/getting-started).
Pour les details de l’assistant, voir [Assistant de prise en main](/start/wizard).
</Note>

Derniere mise a jour : 2026-01-01

## TL;DR

- **La personnalisation vit en dehors du repo :** `~/.openclaw/workspace` (workspace) + `~/.openclaw/openclaw.json` (config).
- **Workflow stable :** installez l’app macOS ; laissez-la executer la Gateway (passerelle) integree.
- **Workflow bleeding edge :** lancez vous-meme la Gateway (passerelle) via `pnpm gateway:watch`, puis laissez l’app macOS s’y connecter en mode Local.

## Prerequis (depuis la source)

- Node `>=22`
- `pnpm`
- Docker (optionnel ; uniquement pour une configuration conteneurisee/e2e — voir [Docker](/install/docker))

## Strategie de personnalisation (pour que les mises a jour ne fassent pas mal)

Si vous voulez « 100 % adapte a moi » _et_ des mises a jour faciles, conservez votre personnalisation dans :

- **Config :** `~/.openclaw/openclaw.json` (JSON/JSON5-like)
- **Workspace :** `~/.openclaw/workspace` (Skills, prompts, memoires ; faites-en un repo git prive)

Bootstrap une seule fois :

```bash
openclaw setup
```

Depuis ce repo, utilisez l’entree CLI locale :

```bash
openclaw setup
```

Si vous n’avez pas encore d’installation globale, lancez-la via `pnpm openclaw setup`.

## Executer la Gateway (passerelle) depuis ce repo

Apres `pnpm build`, vous pouvez executer directement la CLI packagee :

```bash
node openclaw.mjs gateway --port 18789 --verbose
```

## Workflow stable (app macOS en premier)

1. Installez + lancez **OpenClaw.app** (barre de menus).
2. Terminez la checklist de prise en main/autorisations (prompts TCC).
3. Assurez-vous que la Gateway (passerelle) est **Local** et en cours d’execution (l’app la gere).
4. Liez les surfaces (exemple : WhatsApp) :

```bash
openclaw channels login
```

5. Verification rapide :

```bash
openclaw health
```

Si la prise en main n’est pas disponible dans votre build :

- Lancez `openclaw setup`, puis `openclaw channels login`, puis demarrez la Gateway (passerelle) manuellement (`openclaw gateway`).

## Workflow bleeding edge (Gateway dans un terminal)

Objectif : travailler sur la Gateway TypeScript, obtenir le hot reload, et garder l’UI de l’app macOS connectee.

### 0. (Optionnel) Executer aussi l’app macOS depuis la source

Si vous voulez egalement l’app macOS en bleeding edge :

```bash
./scripts/restart-mac.sh
```

### 1. Demarrer la Gateway de dev

```bash
pnpm install
pnpm gateway:watch
```

`gateway:watch` lance la gateway en mode watch et recharge lors des changements TypeScript.

### 2. Pointer l’app macOS vers votre Gateway en cours d’execution

Dans **OpenClaw.app** :

- Mode de connexion : **Local**
  L’app se connectera a la gateway en cours d’execution sur le port configure.

### 3. Verifier

- Le statut de la Gateway dans l’app doit indiquer **« Using existing gateway … »**
- Ou via la CLI :

```bash
openclaw health
```

### Pieges frequents

- **Mauvais port :** le WS de la Gateway (passerelle) est par defaut `ws://127.0.0.1:18789` ; gardez l’app et la CLI sur le meme port.
- **Ou vit l’etat :**
  - Identifiants : `~/.openclaw/credentials/`
  - Sessions : `~/.openclaw/agents/<agentId>/sessions/`
  - Logs : `/tmp/openclaw/`

## Carte de stockage des identifiants

A utiliser pour depanner l’authentification ou decider quoi sauvegarder :

- **WhatsApp** : `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
- **Jeton de bot Telegram** : config/env ou `channels.telegram.tokenFile`
- **Jeton de bot Discord** : config/env (fichier de jeton non encore pris en charge)
- **Jetons Slack** : config/env (`channels.slack.*`)
- **Listes d’autorisations de pairage** : `~/.openclaw/credentials/<channel>-allowFrom.json`
- **Profils d’authentification de modele** : `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- **Import OAuth legacy** : `~/.openclaw/credentials/oauth.json`
  Plus de details : [Securite](/gateway/security#credential-storage-map).

## Mise a jour (sans detruire votre configuration)

- Conservez `~/.openclaw/workspace` et `~/.openclaw/` comme « vos elements » ; ne mettez pas de prompts/config personnels dans le repo `openclaw`.
- Mise a jour de la source : `git pull` + `pnpm install` (quand le lockfile change) + continuez a utiliser `pnpm gateway:watch`.

## Linux (service utilisateur systemd)

Les installations Linux utilisent un service systemd **utilisateur**. Par defaut, systemd arrete les services utilisateur a la deconnexion/inactivite, ce qui tue la Gateway (passerelle). La prise en main tente d’activer le lingering pour vous (peut demander sudo). Si c’est toujours desactive, lancez :

```bash
sudo loginctl enable-linger $USER
```

Pour des serveurs toujours actifs ou multi-utilisateurs, envisagez un service **systeme** plutot qu’un service utilisateur (pas de lingering necessaire). Voir le [runbook de la Gateway](/gateway) pour les notes systemd.

## Docs associees

- [Runbook de la Gateway](/gateway) (flags, supervision, ports)
- [Configuration de la Gateway](/gateway/configuration) (schema de config + exemples)
- [Discord](/channels/discord) et [Telegram](/channels/telegram) (tags de reponse + parametres replyToMode)
- [Configuration de l’assistant OpenClaw](/start/openclaw)
- [App macOS](/platforms/macos) (cycle de vie de la gateway)
