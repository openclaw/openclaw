---
summary: "Comment app mac embarque WebChat Passerelle et comment le déboguer"
read_when:
  - Débogage vue WebChat mac ou port loopback
title: "WebChat"
---

# WebChat (app macOS)

L'app menu bar macOS embarque UI WebChat comme vue SwiftUI native. Se connecte à Passerelle et défaut vers **session main** pour agent sélectionné (avec switcher session pour autres sessions).

- **Mode Local** : connecte directement vers WebSocket Passerelle locale.
- **Mode Remote** : forward port contrôle Passerelle via SSH et utilise ce tunnel comme data plane.

## Lancement & Débogage

- Manuel : menu Lobster → "Open Chat".
- Auto-open pour test :

  ```bash
  dist/OpenClaw.app/Contents/MacOS/OpenClaw --webchat
  ```

- Logs : `./scripts/clawlog.sh` (subsystem `bot.molt`, catégorie `WebChatSwiftUI`).

## Comment câblé

- Data plane : méthodes WS Passerelle `chat.history`, `chat.send`, `chat.abort`, `chat.inject` et événements `chat`, `agent`, `presence`, `tick`, `health`.
- Session : défaut vers session primaire (`main`, ou `global` quand scope global). UI peut switcher entre sessions.
- Onboarding utilise session dédiée pour garder setup first-run séparé.

## Surface Sécurité

- Mode remote forward uniquement port contrôle WebSocket Passerelle via SSH.

## Limitations connues

- UI optimisée pour sessions chat (pas sandbox browser complet).

Voir aussi :

- [App macOS](/fr-FR/platforms/macos)
- [Passerelle](/fr-FR/cli/gateway)
- [Configuration](/fr-FR/gateway/configuration)
