---
summary: "Architecture IPC macOS pour app OpenClaw, transport node gateway et PeekabooBridge"
read_when:
  - Édition contrats IPC ou IPC app menu bar
title: "IPC macOS"
---

# Architecture IPC macOS OpenClaw

**Modèle actuel :** un socket Unix local connecte **service host node** à **app macOS** pour approbations exec + `system.run`. Un CLI debug `openclaw-mac` existe pour checks découverte/connect ; actions agent passent toujours via WebSocket Passerelle et `node.invoke`. Automation UI utilise PeekabooBridge.

## Objectifs

- Instance app GUI unique qui possède tout travail TCC-facing (notifications, screen recording, mic, speech, AppleScript).
- Surface réduite pour automation : Passerelle + commandes node, plus PeekabooBridge pour automation UI.
- Permissions prévisibles : toujours même bundle ID signé, lancé par launchd, donc permissions TCC restent.

## Comment ça fonctionne

### Passerelle + transport node

- App exécute Passerelle (mode local) et s'y connecte comme node.
- Actions agent performées via `node.invoke` (ex : `system.run`, `system.notify`, `canvas.*`).

### Service node + IPC app

- Service host node headless se connecte au WebSocket Passerelle.
- Requêtes `system.run` forwardées vers app macOS via socket Unix local.
- App performe exec dans contexte UI, prompt si nécessaire, retourne output.

Diagramme (SCI) :

```
Agent -> Passerelle -> Service Node (WS)
                       |  IPC (UDS + token + HMAC + TTL)
                       v
                   App Mac (UI + TCC + system.run)
```

### PeekabooBridge (automation UI)

- Automation UI utilise socket UNIX séparé nommé `bridge.sock` et protocole JSON PeekabooBridge.
- Ordre préférence host (côté client) : Peekaboo.app → Claude.app → OpenClaw.app → exécution locale.
- Sécurité : hosts bridge requièrent TeamID autorisé ; échappatoire same-UID DEBUG-only gardée par `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` (convention Peekaboo).
- Voir : [Utilisation PeekabooBridge](/fr-FR/platforms/mac/peekaboo) pour détails.

## Flux opérationnels

- Restart/rebuild : `SIGN_IDENTITY="Apple Development: <Developer Name> (<TEAMID>)" scripts/restart-mac.sh`
  - Tue instances existantes
  - Build Swift + package
  - Écrit/bootstrap/kickstart LaunchAgent
- Instance unique : app exit early si autre instance même bundle ID tourne.

## Notes durcissement

- Préférer exiger match TeamID pour toutes surfaces privilégiées.
- PeekabooBridge : `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` (DEBUG-only) peut autoriser callers same-UID pour développement local.
- Toute communication reste local-only ; aucun socket réseau exposé.
- Prompts TCC originent uniquement depuis bundle app GUI ; garder bundle ID signé stable entre rebuilds.
- Durcissement IPC : mode socket `0600`, token, checks peer-UID, défi/réponse HMAC, TTL court.

Voir aussi :

- [App macOS](/fr-FR/platforms/macos)
- [PeekabooBridge](/fr-FR/platforms/mac/peekaboo)
- [Configuration](/fr-FR/gateway/configuration)
