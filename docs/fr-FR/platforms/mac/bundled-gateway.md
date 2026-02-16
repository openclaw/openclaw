---
summary: "Runtime Passerelle sur macOS (service launchd externe)"
read_when:
  - Packaging OpenClaw.app
  - Débogage service launchd passerelle macOS
  - Installation CLI passerelle pour macOS
title: "Passerelle sur macOS"
---

# Passerelle sur macOS (launchd externe)

OpenClaw.app n'embarque plus Node/Bun ni le runtime Passerelle. L'app macOS attend une installation CLI `openclaw` **externe**, ne spawn pas la Passerelle comme processus enfant, et gère un service launchd per-user pour garder la Passerelle en cours (ou s'attache à une Passerelle locale existante si une fonctionne déjà).

## Installer le CLI (requis pour mode local)

Vous avez besoin de Node 22+ sur le Mac, puis installez `openclaw` globalement :

```bash
npm install -g openclaw@<version>
```

Le bouton **Install CLI** de l'app macOS exécute le même flux via npm/pnpm (bun non recommandé pour runtime Passerelle).

## Launchd (Passerelle comme LaunchAgent)

Label :

- `bot.molt.gateway` (ou `bot.molt.<profile>` ; legacy `com.openclaw.*` peut rester)

Emplacement plist (per-user) :

- `~/Library/LaunchAgents/bot.molt.gateway.plist`
  (ou `~/Library/LaunchAgents/bot.molt.<profile>.plist`)

Manager :

- L'app macOS possède l'installation/mise à jour LaunchAgent en mode Local.
- Le CLI peut aussi l'installer : `openclaw gateway install`.

Comportement :

- "OpenClaw Active" active/désactive le LaunchAgent.
- Quitter l'app ne **stop pas** la passerelle (launchd la garde en vie).
- Si une Passerelle fonctionne déjà sur le port configuré, l'app s'y attache au lieu d'en démarrer une nouvelle.

Logging :

- stdout/err launchd : `/tmp/openclaw/openclaw-gateway.log`

## Compatibilité version

L'app macOS vérifie la version passerelle contre sa propre version. Si elles sont incompatibles, mettez à jour le CLI global pour correspondre à la version app.

## Smoke check

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

Voir aussi :

- [App macOS](/fr-FR/platforms/macos)
- [Permissions macOS](/fr-FR/platforms/mac/permissions)
- [Configuration Passerelle](/fr-FR/gateway/configuration)
