---
summary: "Adaptateurs RPC pour des CLI externes (signal-cli, imsg legacy) et des modeles de passerelle"
read_when:
  - Ajout ou modification d'integrations CLI externes
  - Debogage des adaptateurs RPC (signal-cli, imsg)
title: "Adaptateurs RPC"
---

# Adaptateurs RPC

OpenClaw integre des CLI externes via JSON-RPC. Deux modeles sont utilises aujourd'hui.

## Modele A : daemon HTTP (signal-cli)

- `signal-cli` s'execute comme un daemon avec JSON-RPC sur HTTP.
- Le flux d'evenements est en SSE (`/api/v1/events`).
- Sonde de sante : `/api/v1/check`.
- OpenClaw possede le cycle de vie lorsque `channels.signal.autoStart=true`.

Voir [Signal](/channels/signal) pour la configuration et les endpoints.

## Modele B : processus enfant via stdio (legacy : imsg)

> **Note :** Pour les nouvelles configurations iMessage, utilisez plutot [BlueBubbles](/channels/bluebubbles).

- OpenClaw lance `imsg rpc` comme processus enfant (integration iMessage legacy).
- JSON-RPC est delimite par lignes sur stdin/stdout (un objet JSON par ligne).
- Aucun port TCP, aucun daemon requis.

Methodes principales utilisees :

- `watch.subscribe` → notifications (`method: "message"`)
- `watch.unsubscribe`
- `send`
- `chats.list` (sonde/diagnostics)

Voir [iMessage](/channels/imessage) pour la configuration legacy et l'adressage (`chat_id` prefere).

## Directives pour les adaptateurs

- Le Gateway (passerelle) possede le processus (demarrage/arret lies au cycle de vie du fournisseur).
- Rendez les clients RPC resilients : delais d'attente, redemarrage en cas de sortie.
- Preferez des ID stables (par exemple, `chat_id`) aux chaines d'affichage.
