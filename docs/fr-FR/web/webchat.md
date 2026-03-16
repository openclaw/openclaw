---
summary: "Hôte statique WebChat loopback et utilisation du WS de Passerelle pour l'UI de chat"
read_when:
  - Déboguer ou configurer l'accès WebChat
title: "WebChat"
---

# WebChat (UI WebSocket de Passerelle)

Statut : l'UI de chat SwiftUI macOS/iOS parle directement au WebSocket de Passerelle.

## Ce que c'est

- Une UI de chat native pour la passerelle (pas de navigateur intégré et pas de serveur statique local).
- Utilise les mêmes sessions et règles de routage que les autres canaux.
- Routage déterministe : les réponses reviennent toujours à WebChat.

## Démarrage rapide

1. Démarrez la passerelle.
2. Ouvrez l'UI WebChat (app macOS/iOS) ou l'onglet de chat de l'UI de contrôle.
3. Assurez-vous que l'authentification de passerelle est configurée (requise par défaut, même sur loopback).

## Comment ça fonctionne (comportement)

- L'UI se connecte au WebSocket de Passerelle et utilise `chat.history`, `chat.send`, et `chat.inject`.
- `chat.inject` ajoute une note d'assistant directement à la transcription et la diffuse à l'UI (pas d'exécution d'agent).
- L'historique est toujours récupéré depuis la passerelle (pas de surveillance de fichier local).
- Si la passerelle est inaccessible, WebChat est en lecture seule.

## Utilisation distante

- Le mode distant tunnel le WebSocket de passerelle via SSH/Tailscale.
- Vous n'avez pas besoin d'exécuter un serveur WebChat séparé.

## Référence de configuration (WebChat)

Configuration complète : [Configuration](/fr-FR/gateway/configuration)

Options de canal :

- Pas de bloc `webchat.*` dédié. WebChat utilise le point de terminaison de passerelle + les paramètres d'auth ci-dessous.

Options globales connexes :

- `gateway.port`, `gateway.bind` : Hôte/port WebSocket.
- `gateway.auth.mode`, `gateway.auth.token`, `gateway.auth.password` : Authentification WebSocket (token/mot de passe).
- `gateway.auth.mode: "trusted-proxy"` : Authentification reverse-proxy pour les clients navigateur (voir [Authentification Trusted Proxy](/fr-FR/gateway/trusted-proxy-auth)).
- `gateway.remote.url`, `gateway.remote.token`, `gateway.remote.password` : Cible de passerelle distante.
- `session.*` : Stockage de session et défauts de clé principale.
