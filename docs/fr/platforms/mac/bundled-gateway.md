---
summary: "Runtime de la Gateway sur macOS (service launchd externe)"
read_when:
  - Packaging de OpenClaw.app
  - Debogage du service launchd de la Gateway sur macOS
  - Installation de la CLI de la Gateway pour macOS
title: "Gateway sur macOS"
---

# Gateway sur macOS (launchd externe)

OpenClaw.app n’intègre plus Node/Bun ni le runtime de la Gateway. L’application macOS
attend une installation **externe** de la CLI `openclaw`, ne lance pas la Gateway comme
processus enfant et gere un service launchd par utilisateur pour maintenir la Gateway
en fonctionnement (ou se connecte a une Gateway locale existante si elle est deja en cours
d’execution).

## Installer la CLI (requis pour le mode local)

Vous avez besoin de Node 22+ sur le Mac, puis installez `openclaw` globalement :

```bash
npm install -g openclaw@<version>
```

Le bouton **Install CLI** de l’application macOS execute le meme flux via npm/pnpm (bun n’est pas recommande pour le runtime de la Gateway).

## Launchd (Gateway comme LaunchAgent)

Label :

- `bot.molt.gateway` (ou `bot.molt.<profile>` ; l’ancienne valeur `com.openclaw.*` peut subsister)

Emplacement du plist (par utilisateur) :

- `~/Library/LaunchAgents/bot.molt.gateway.plist`
  (ou `~/Library/LaunchAgents/bot.molt.<profile>.plist`)

Gestionnaire :

- L’application macOS gere l’installation/la mise a jour du LaunchAgent en mode local.
- La CLI peut egalement l’installer : `openclaw gateway install`.

Comportement :

- « OpenClaw Active » active/desactive le LaunchAgent.
- La fermeture de l’application **n’arrete pas** la Gateway (launchd la maintient active).
- Si une Gateway est deja en cours d’execution sur le port configure, l’application s’y connecte
  au lieu d’en demarrer une nouvelle.

Journalisation :

- stdout/err de launchd : `/tmp/openclaw/openclaw-gateway.log`

## Compatibilite des versions

L’application macOS verifie la version de la Gateway par rapport a la sienne. Si elles sont
incompatibles, mettez a jour la CLI globale pour qu’elle corresponde a la version de
l’application.

## Contrôle de fumée

```bash
openclaw --version

OPENCLAW_SKIP_CHANNELS=1 \
OPENCLAW_SKIP_CANVAS_HOST=1 \
openclaw gateway --port 18999 --bind loopback
```

Puis :

```bash
openclaw gateway call health --url ws://127.0.0.1:18999 --timeout 3000
```
