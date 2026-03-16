---
summary: "Adaptateurs RPC pour CLI externes (signal-cli, imsg legacy) et patterns passerelle"
read_when:
  - Ajout ou modification d'intégrations CLI externes
  - Débogage des adaptateurs RPC (signal-cli, imsg)
title: "Adaptateurs RPC"
---

# Adaptateurs RPC

OpenClaw intègre des CLI externes via JSON-RPC. Deux patterns sont utilisés aujourd'hui.

## Pattern A : Daemon HTTP (signal-cli)

- `signal-cli` s'exécute en tant que daemon avec JSON-RPC sur HTTP.
- Le flux d'événements est SSE (`/api/v1/events`).
- Sonde de santé : `/api/v1/check`.
- OpenClaw gère le cycle de vie lorsque `channels.signal.autoStart=true`.

Voir [Signal](/fr-FR/channels/signal) pour la configuration et les endpoints.

## Pattern B : Processus enfant stdio (legacy : imsg)

> **Remarque :** Pour les nouvelles installations iMessage, utilisez [BlueBubbles](/fr-FR/channels/bluebubbles) à la place.

- OpenClaw spawne `imsg rpc` en tant que processus enfant (intégration iMessage legacy).
- JSON-RPC est délimité par ligne sur stdin/stdout (un objet JSON par ligne).
- Pas de port TCP, pas de daemon requis.

Méthodes principales utilisées :

- `watch.subscribe` → notifications (`method: "message"`)
- `watch.unsubscribe`
- `send`
- `chats.list` (sonde/diagnostics)

Voir [iMessage](/fr-FR/channels/imessage) pour la configuration legacy et l'adressage (`chat_id` préféré).

## Directives des adaptateurs

- La Passerelle possède le processus (démarrage/arrêt lié au cycle de vie du fournisseur).
- Gardez les clients RPC résilients : timeouts, redémarrage à la sortie.
- Préférez les ID stables (par ex., `chat_id`) aux chaînes d'affichage.
