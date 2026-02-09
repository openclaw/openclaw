---
summary: "Accès à distance via des tunnels SSH (Gateway WS) et des tailnets"
read_when:
  - Exécution ou dépannage de configurations de passerelle distante
title: "Accès à distance"
---

# Accès à distance (SSH, tunnels et tailnets)

Ce dépôt prend en charge le « distant via SSH » en maintenant une seule Gateway (la principale) en fonctionnement sur un hôte dédié (poste de travail/serveur) et en y connectant les clients.

- Pour les **opérateurs (vous / l’application macOS)** : le tunneling SSH est le repli universel.
- Pour les **nœuds (iOS/Android et futurs appareils)** : connexion au **WebSocket** de la Gateway (LAN/tailnet ou tunnel SSH selon les besoins).

## L’idée centrale

- Le WebSocket de la Gateway se lie à la **boucle locale** sur le port configuré (18789 par défaut).
- Pour une utilisation à distance, vous transférez ce port loopback via SSH (ou utilisez un tailnet/VPN et réduisez le besoin de tunnel).

## Configurations VPN/tailnet courantes (où vit l’agent)

Considérez l’**hôte de la Gateway** comme « là où vit l’agent ». Il possède les sessions, profils d’authentification, canaux et l’état.
Votre ordinateur portable/de bureau (et les nœuds) se connectent à cet hôte.

### 1. Gateway toujours active dans votre tailnet (VPS ou serveur domestique)

Exécutez la Gateway sur un hôte persistant et accédez-y via **Tailscale** ou SSH.

- **Meilleure UX :** conservez `gateway.bind: "loopback"` et utilisez **Tailscale Serve** pour l’interface de contrôle.
- **Repli :** conservez la boucle locale + tunnel SSH depuis toute machine nécessitant l’accès.
- **Exemples :** [exe.dev](/install/exe-dev) (VM facile) ou [Hetzner](/install/hetzner) (VPS de production).

C’est idéal lorsque votre ordinateur portable se met souvent en veille mais que vous souhaitez un agent toujours actif.

### 2. Le bureau à domicile exécute la Gateway, l’ordinateur portable est la télécommande

L’ordinateur portable n’exécute **pas** l’agent. Il se connecte à distance :

- Utilisez le mode **Remote over SSH** de l’application macOS (Réglages → Général → « OpenClaw runs »).
- L’application ouvre et gère le tunnel, de sorte que WebChat + les vérifications d’état fonctionnent « tout simplement ».

Runbook : [accès à distance macOS](/platforms/mac/remote).

### 3. L’ordinateur portable exécute la Gateway, accès à distance depuis d’autres machines

Conservez la Gateway en local mais exposez-la en toute sécurité :

- Tunnel SSH vers l’ordinateur portable depuis d’autres machines, ou
- Tailscale Serve pour l’interface de contrôle et conservez la Gateway en loopback uniquement.

Guide : [Tailscale](/gateway/tailscale) et [Présentation Web](/web).

## Flux de commandes (quoi s’exécute où)

Un service de gateway unique possède l’état + les canaux. Les nœuds sont des périphériques.

Exemple de flux (Telegram → nœud) :

- Un message Telegram arrive à la **Gateway**.
- La Gateway exécute l’**agent** et décide s’il faut appeler un outil de nœud.
- La Gateway appelle le **nœud** via le WebSocket de la Gateway (RPC `node.*`).
- Le nœud renvoie le résultat ; la Gateway répond ensuite à Telegram.

Notes :

- **Les nœuds n’exécutent pas le service de gateway.** Une seule gateway doit s’exécuter par hôte, sauf si vous exécutez intentionnellement des profils isolés (voir [Gateways multiples](/gateway/multiple-gateways)).
- Le « mode nœud » de l’application macOS n’est qu’un client nœud via le WebSocket de la Gateway.

## Tunnel SSH (CLI + outils)

Créez un tunnel local vers le WS de la Gateway distante :

```bash
ssh -N -L 18789:127.0.0.1:18789 user@host
```

Avec le tunnel actif :

- `openclaw health` et `openclaw status --deep` atteignent désormais la gateway distante via `ws://127.0.0.1:18789`.
- `openclaw gateway {status,health,send,agent,call}` peut également cibler l’URL transférée via `--url` lorsque nécessaire.

Remarque : remplacez `18789` par votre `gateway.port` configuré (ou `--port`/`OPENCLAW_GATEWAY_PORT`).
Remarque : lorsque vous passez `--url`, la CLI ne se replie pas sur la configuration ni sur les identifiants d’environnement.
Incluez `--token` ou `--password` explicitement. L’absence d’identifiants explicites est une erreur.

## Valeurs par défaut distantes de la CLI

Vous pouvez conserver une cible distante afin que les commandes CLI l’utilisent par défaut :

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

Lorsque la gateway est uniquement en loopback, conservez l’URL à `ws://127.0.0.1:18789` et ouvrez d’abord le tunnel SSH.

## Interface de chat via SSH

WebChat n’utilise plus de port HTTP séparé. L’interface de chat SwiftUI se connecte directement au WebSocket de la Gateway.

- Transférez `18789` via SSH (voir ci-dessus), puis connectez les clients à `ws://127.0.0.1:18789`.
- Sur macOS, privilégiez le mode « Remote over SSH » de l’application, qui gère automatiquement le tunnel.

## Application macOS « Remote over SSH »

L’application de barre de menus macOS peut piloter la même configuration de bout en bout (vérifications d’état à distance, WebChat et transfert Voice Wake).

Runbook : [accès à distance macOS](/platforms/mac/remote).

## Règles de sécurité (distant/VPN)

Version courte : **conservez la Gateway en loopback uniquement** sauf si vous êtes certain d’avoir besoin d’un bind.

- **Loopback + SSH/Tailscale Serve** est le choix par défaut le plus sûr (aucune exposition publique).
- **Binds hors loopback** (`lan`/`tailnet`/`custom`, ou `auto` lorsque le loopback est indisponible) doivent utiliser des jetons/mots de passe d’authentification.
- `gateway.remote.token` est **uniquement** pour les appels CLI distants — il n’active **pas** l’authentification locale.
- `gateway.remote.tlsFingerprint` épingle le certificat TLS distant lors de l’utilisation de `wss://`.
- **Tailscale Serve** peut s’authentifier via des en-têtes d’identité lorsque `gateway.auth.allowTailscale: true`.
  Réglez-le sur `false` si vous souhaitez des jetons/mots de passe à la place.
- Traitez le contrôle navigateur comme un accès opérateur : tailnet uniquement + appairage de nœuds délibéré.

Analyse approfondie : [Sécurité](/gateway/security).
