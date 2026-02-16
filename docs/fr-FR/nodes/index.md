---
summary: "Nœuds : appairage, capacités, permissions et helpers CLI pour canvas/camera/screen/system"
read_when:
  - Appairage nœuds iOS/Android à une passerelle
  - Utilisation canvas/camera nœud pour contexte agent
  - Ajout nouvelles commandes nœud ou helpers CLI
title: "Nœuds"
---

# Nœuds

Un **nœud** est un device compagnon (macOS/iOS/Android/headless) qui se connecte au **WebSocket** Passerelle (même port que les opérateurs) avec `role: "node"` et expose une surface commande (par ex. `canvas.*`, `camera.*`, `system.*`) via `node.invoke`. Détails protocole : [Protocole Passerelle](/fr-FR/gateway/protocol).

macOS peut aussi fonctionner en **mode nœud** : l'app menubar se connecte au serveur WS Passerelle et expose ses commandes canvas/camera locales comme nœud.

Notes :

- Les nœuds sont des **périphériques**, pas des passerelles.
- Les messages Telegram/WhatsApp/etc. atterrissent sur la **passerelle**, pas sur les nœuds.
- Runbook dépannage : [/fr-FR/nodes/troubleshooting](/fr-FR/nodes/troubleshooting)

## Appairage + status

Les nœuds WS utilisent l'appairage device. Approuvez via le CLI devices (ou UI).

CLI rapide :

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw nodes status
```

## Hôte nœud distant

Utilisez un hôte nœud quand votre Passerelle fonctionne sur une machine et vous voulez que les commandes s'exécutent sur une autre.

Sur la machine nœud :

```bash
openclaw node run --host <gateway-host> --port 18789 --display-name "Build Node"
```

Voir aussi :

- [CLI hôte Nœud](/fr-FR/cli/node)
- [Outil Exec](/fr-FR/tools/exec)
- [Approbations Exec](/fr-FR/tools/exec-approvals)
