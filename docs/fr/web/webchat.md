---
summary: "Hébergement statique WebChat en local loopback et utilisation du WS du Gateway pour l’UI de chat"
read_when:
  - Débogage ou configuration de l’accès WebChat
title: "WebChat"
---

# WebChat (UI WebSocket du Gateway)

Statut : l’UI de chat SwiftUI macOS/iOS communique directement avec le WebSocket du Gateway (passerelle).

## Qu’est-ce que c’est

- Une UI de chat native pour le gateway (aucun navigateur intégré et aucun serveur statique local).
- Utilise les mêmes sessions et règles de routage que les autres canaux.
- Routage déterministe : les réponses reviennent toujours à WebChat.

## Demarrage rapide

1. Démarrez le gateway.
2. Ouvrez l’UI WebChat (application macOS/iOS) ou l’onglet de chat de l’UI de contrôle.
3. Assurez-vous que l’authentification du gateway est configurée (requise par défaut, même en local loopback).

## Comment ça marche (comportement)

- L’UI se connecte au WebSocket du Gateway et utilise `chat.history`, `chat.send` et `chat.inject`.
- `chat.inject` ajoute une note de l’assistant directement à la transcription et la diffuse à l’UI (sans exécution d’agent).
- L’historique est toujours récupéré depuis le gateway (pas de surveillance de fichiers locaux).
- Si le gateway est inaccessible, WebChat est en lecture seule.

## Utilisation à distance

- Le mode distant tunnelise le WebSocket du gateway via SSH/Tailscale.
- Vous n’avez pas besoin d’exécuter un serveur WebChat séparé.

## Référence de configuration (WebChat)

Configuration complète : [Configuration](/gateway/configuration)

Options de canal :

- Aucun bloc `webchat.*` dédié. WebChat utilise le point de terminaison du gateway + les paramètres d’authentification ci-dessous.

Options globales associées :

- `gateway.port`, `gateway.bind` : hôte/port WebSocket.
- `gateway.auth.mode`, `gateway.auth.token`, `gateway.auth.password` : authentification WebSocket.
- `gateway.remote.url`, `gateway.remote.token`, `gateway.remote.password` : cible du gateway distant.
- `session.*` : stockage de session et valeurs par défaut de la clé principale.
