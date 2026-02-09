---
summary: "Architecture IPC macOS pour l’application OpenClaw, le transport du nœud Gateway (passerelle) et PeekabooBridge"
read_when:
  - Modification des contrats IPC ou de l’IPC de l’application de barre de menus
title: "IPC macOS"
---

# Architecture IPC macOS d’OpenClaw

**Modèle actuel :** un socket Unix local connecte le **service hôte de nœud** à l’**application macOS** pour les approbations d’exec + `system.run`. Un CLI de débogage `openclaw-mac` existe pour les vérifications de découverte/connexion ; les actions de l’agent transitent toujours via le WebSocket de la Gateway (passerelle) et `node.invoke`. L’automatisation de l’UI utilise PeekabooBridge.

## Objectifs

- Une seule instance d’application GUI qui possède tout le travail côté TCC (notifications, enregistrement d’écran, micro, synthèse vocale, AppleScript).
- Une surface d’automatisation réduite : Gateway (passerelle) + commandes de nœud, plus PeekabooBridge pour l’automatisation de l’UI.
- Des autorisations prévisibles : toujours le même bundle ID signé, lancé par launchd, afin que les autorisations TCC persistent.

## Fonctionnement

### Transport Gateway (passerelle) + nœud

- L’application exécute la Gateway (passerelle) (mode local) et s’y connecte en tant que nœud.
- Les actions de l’agent sont exécutées via `node.invoke` (p. ex. `system.run`, `system.notify`, `canvas.*`).

### Service de nœud + IPC de l’application

- Un service hôte de nœud sans interface se connecte au WebSocket de la Gateway (passerelle).
- Les requêtes `system.run` sont transmises à l’application macOS via un socket Unix local.
- L’application effectue l’exec dans le contexte UI, affiche une invite si nécessaire, et renvoie la sortie.

Schéma (SCI) :

```
Agent -> Gateway -> Node Service (WS)
                      |  IPC (UDS + token + HMAC + TTL)
                      v
                  Mac App (UI + TCC + system.run)
```

### PeekabooBridge (automatisation de l’UI)

- L’automatisation de l’UI utilise un socket UNIX distinct nommé `bridge.sock` et le protocole JSON PeekabooBridge.
- Ordre de préférence des hôtes (côté client) : Peekaboo.app → Claude.app → OpenClaw.app → exécution locale.
- Sécurité : les hôtes de bridge exigent un TeamID autorisé ; une échappatoire DEBUG uniquement à UID identique est protégée par `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` (convention Peekaboo).
- Voir : [Utilisation de PeekabooBridge](/platforms/mac/peekaboo) pour plus de détails.

## Flux opérationnels

- Redémarrage/reconstruction : `SIGN_IDENTITY="Apple Development: <Developer Name> (<TEAMID>)" scripts/restart-mac.sh`
  - Tue les instances existantes
  - Build Swift + empaquetage
  - Écrit/initialise/démarre (kickstart) le LaunchAgent
- Instance unique : l’application se ferme immédiatement si une autre instance avec le même bundle ID est en cours d’exécution.

## Notes de durcissement

- Privilégier l’exigence d’une correspondance de TeamID pour toutes les surfaces privilégiées.
- PeekabooBridge : `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` (DEBUG uniquement) peut autoriser des appelants au même UID pour le développement local.
- Toutes les communications restent strictement locales ; aucun socket réseau n’est exposé.
- Les invites TCC proviennent uniquement du bundle de l’application GUI ; conserver un bundle ID signé stable entre les reconstructions.
- Durcissement IPC : mode de socket `0600`, jeton, vérifications d’UID du pair, défi/réponse HMAC, TTL court.
