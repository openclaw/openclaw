---
summary: "Accès distant utilisant les tunnels SSH (WS Passerelle) et tailnets"
read_when:
  - Exécution ou dépannage de configurations passerelle distantes
title: "Accès distant"
---

# Accès distant (SSH, tunnels et tailnets)

Ce dépôt supporte "distant via SSH" en gardant une seule Passerelle (le maître) s'exécutant sur un hôte dédié (desktop/serveur) et en y connectant les clients.

- Pour **les opérateurs (vous / l'app macOS)** : le tunneling SSH est le fallback universel.
- Pour **les nœuds (iOS/Android et appareils futurs)** : connectez-vous au **WebSocket** Passerelle (LAN/tailnet ou tunnel SSH selon les besoins).

## L'idée de base

- Le WebSocket Passerelle se lie à **loopback** sur votre port configuré (défaut 18789).
- Pour usage distant, vous transférez ce port loopback via SSH (ou utilisez un tailnet/VPN et tunnelisez moins).

## Configurations VPN/tailnet courantes (où vit l'agent)

Pensez à **l'hôte Passerelle** comme "où vit l'agent". Il possède les sessions, profils auth, canaux et état. Votre laptop/desktop (et nœuds) se connectent à cet hôte.

### 1) Passerelle toujours active dans votre tailnet (VPS ou serveur maison)

Exécutez la Passerelle sur un hôte persistant et atteignez-la via **Tailscale** ou SSH.

- **Meilleure UX :** gardez `gateway.bind: "loopback"` et utilisez **Tailscale Serve** pour l'UI de contrôle.
- **Fallback :** gardez loopback + tunnel SSH depuis toute machine nécessitant l'accès.
- **Exemples :** [exe.dev](/fr-FR/install/exe-dev) (VM facile) ou [Hetzner](/fr-FR/install/hetzner) (VPS production).

C'est idéal quand votre laptop dort souvent mais vous voulez que l'agent soit toujours actif.

### 2) Desktop maison exécute la Passerelle, laptop est contrôle distant

Le laptop n'**exécute pas** l'agent. Il se connecte à distance :

- Utilisez le mode **Remote over SSH** de l'app macOS (Paramètres → Général → "OpenClaw s'exécute").
- L'app ouvre et gère le tunnel, donc WebChat + vérifications de santé "fonctionnent juste".

Manuel d'exécution : [accès distant macOS](/fr-FR/platforms/mac/remote).

### 3) Laptop exécute la Passerelle, accès distant depuis d'autres machines

Gardez la Passerelle locale mais exposez-la en sécurité :

- Tunnel SSH vers le laptop depuis d'autres machines, ou
- Tailscale Serve l'UI de contrôle et gardez la Passerelle loopback-uniquement.

Guide : [Tailscale](/fr-FR/gateway/tailscale) et [Aperçu web](/fr-FR/web).

## Flux de commande (qu'est-ce qui s'exécute où)

Un service passerelle possède l'état + les canaux. Les nœuds sont des périphériques.

Exemple de flux (Telegram → nœud) :

- Le message Telegram arrive à la **Passerelle**.
- La Passerelle exécute l'**agent** et décide s'il faut appeler un outil nœud.
- La Passerelle appelle le **nœud** via le WebSocket Passerelle (RPC `node.*`).
- Le nœud retourne le résultat ; la Passerelle répond vers Telegram.

Notes :

- **Les nœuds n'exécutent pas le service passerelle.** Une seule passerelle devrait s'exécuter par hôte sauf si vous exécutez intentionnellement des profils isolés (voir [Passerelles multiples](/fr-FR/gateway/multiple-gateways)).
- Le "mode nœud" de l'app macOS est juste un client nœud via le WebSocket Passerelle.

## Tunnel SSH (CLI + outils)

Créez un tunnel local vers le WS Passerelle distant :

```bash
ssh -N -L 18789:127.0.0.1:18789 user@host
```

Avec le tunnel actif :

- `openclaw health` et `openclaw status --deep` atteignent maintenant la passerelle distante via `ws://127.0.0.1:18789`.
- `openclaw gateway {status,health,send,agent,call}` peut aussi cibler l'URL transférée via `--url` si nécessaire.

Note : remplacez `18789` avec votre `gateway.port` configuré (ou `--port`/`OPENCLAW_GATEWAY_PORT`).
Note : lorsque vous passez `--url`, le CLI ne revient pas aux credentials config ou environnement.
Incluez `--token` ou `--password` explicitement. Des credentials explicites manquants sont une erreur.

## Défauts distants CLI

Vous pouvez persister une cible distante pour que les commandes CLI l'utilisent par défaut :

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      url: "ws://127.0.0.1:18789",
      token: "your-token",
    },
  },
}
```

Lorsque la passerelle est loopback-uniquement, gardez l'URL à `ws://127.0.0.1:18789` et ouvrez le tunnel SSH d'abord.

## UI de chat via SSH

WebChat n'utilise plus de port HTTP séparé. L'UI de chat SwiftUI se connecte directement au WebSocket Passerelle.

- Transférez `18789` via SSH (voir ci-dessus), puis connectez les clients à `ws://127.0.0.1:18789`.
- Sur macOS, préférez le mode "Remote over SSH" de l'app, qui gère le tunnel automatiquement.

## App macOS "Remote over SSH"

L'app barre de menu macOS peut piloter la même configuration de bout en bout (vérifications de statut distantes, WebChat et transfert Voice Wake).

Manuel d'exécution : [accès distant macOS](/fr-FR/platforms/mac/remote).

## Règles de sécurité (distant/VPN)

Version courte : **gardez la Passerelle loopback-uniquement** sauf si vous êtes sûr d'avoir besoin d'une liaison.

- **Loopback + SSH/Tailscale Serve** est le défaut le plus sûr (pas d'exposition publique).
- **Les liaisons non-loopback** (`lan`/`tailnet`/`custom`, ou `auto` quand loopback n'est pas disponible) doivent utiliser des tokens/mots de passe auth.
- `gateway.remote.token` est **uniquement** pour les appels CLI distants — il n'**active pas** l'auth locale.
- `gateway.remote.tlsFingerprint` épingle le cert TLS distant lors de l'utilisation de `wss://`.
- **Tailscale Serve** peut s'authentifier via des en-têtes d'identité lorsque `gateway.auth.allowTailscale: true`. Définissez-le à `false` si vous voulez des tokens/mots de passe à la place.
- Traitez le contrôle navigateur comme l'accès opérateur : tailnet-uniquement + appairage de nœud délibéré.

Plongée profonde : [Sécurité](/fr-FR/gateway/security).
