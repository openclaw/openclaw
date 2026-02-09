---
summary: "Serve/Funnel Tailscale intégré pour le tableau de bord de la Gateway (passerelle)"
read_when:
  - Exposer l’interface de contrôle de la Gateway (passerelle) en dehors de localhost
  - Automatiser l’accès au tableau de bord via le tailnet ou en public
title: "Tailscale"
---

# Tailscale (tableau de bord de la Gateway (passerelle))

OpenClaw peut configurer automatiquement Tailscale **Serve** (tailnet) ou **Funnel** (public) pour le
tableau de bord de la Gateway (passerelle) et le port WebSocket. Cela permet de conserver la Gateway liée au loopback tandis que
Tailscale fournit HTTPS, le routage et (pour Serve) des en-têtes d’identité.

## Modes

- `serve` : Serve uniquement sur le tailnet via `tailscale serve`. La Gateway reste sur `127.0.0.1`.
- `funnel` : HTTPS public via `tailscale funnel`. OpenClaw requiert un mot de passe partagé.
- `off` : Par défaut (aucune automatisation Tailscale).

## Auth

Définissez `gateway.auth.mode` pour contrôler la négociation :

- `token` (par défaut lorsque `OPENCLAW_GATEWAY_TOKEN` est défini)
- `password` (secret partagé via `OPENCLAW_GATEWAY_PASSWORD` ou la configuration)

Lorsque `tailscale.mode = "serve"` et que `gateway.auth.allowTailscale` est `true`,
les requêtes proxy Serve valides peuvent s’authentifier via les en-têtes d’identité Tailscale
(`tailscale-user-login`) sans fournir de jeton/mot de passe. OpenClaw vérifie
l’identité en résolvant l’adresse `x-forwarded-for` via le démon Tailscale
local (`tailscale whois`) et en la faisant correspondre à l’en-tête avant de l’accepter.
OpenClaw ne considère une requête comme Serve que lorsqu’elle arrive depuis le loopback avec
les en-têtes Tailscale `x-forwarded-for`, `x-forwarded-proto` et `x-forwarded-host`.
Pour exiger des identifiants explicites, définissez `gateway.auth.allowTailscale: false` ou
forcez `gateway.auth.mode: "password"`.

## Exemples de configuration

### Tailnet uniquement (Serve)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

Ouvrez : `https://<magicdns>/` (ou votre `gateway.controlUi.basePath` configuré)

### Tailnet uniquement (liaison à l’IP du Tailnet)

Utilisez ceci lorsque vous souhaitez que la Gateway écoute directement sur l’IP du Tailnet (sans Serve/Funnel).

```json5
{
  gateway: {
    bind: "tailnet",
    auth: { mode: "token", token: "your-token" },
  },
}
```

Connexion depuis un autre appareil du Tailnet :

- Interface de contrôle : `http://<tailscale-ip>:18789/`
- WebSocket : `ws://<tailscale-ip>:18789`

Remarque : le loopback (`http://127.0.0.1:18789`) **ne** fonctionnera **pas** dans ce mode.

### Internet public (Funnel + mot de passe partagé)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password", password: "replace-me" },
  },
}
```

Préférez `OPENCLAW_GATEWAY_PASSWORD` plutôt que d’enregistrer un mot de passe sur le disque.

## Exemples CLI

```bash
openclaw gateway --tailscale serve
openclaw gateway --tailscale funnel --auth password
```

## Notes

- Tailscale Serve/Funnel nécessite que la CLI `tailscale` soit installée et connectée.
- `tailscale.mode: "funnel"` refuse de démarrer sauf si le mode d’authentification est `password` afin d’éviter une exposition publique.
- Définissez `gateway.tailscale.resetOnExit` si vous souhaitez qu’OpenClaw annule la configuration `tailscale serve`
  ou `tailscale funnel` à l’arrêt.
- `gateway.bind: "tailnet"` est une liaison directe au Tailnet (pas de HTTPS, pas de Serve/Funnel).
- `gateway.bind: "auto"` privilégie le loopback ; utilisez `tailnet` si vous souhaitez un accès uniquement Tailnet.
- Serve/Funnel n’exposent que **l’interface de contrôle de la Gateway + WS**. Les nœuds se connectent via
  le même point de terminaison WS de la Gateway, donc Serve peut fonctionner pour l’accès des nœuds.

## Contrôle du navigateur (Gateway distante + navigateur local)

Si vous exécutez la Gateway sur une machine mais souhaitez piloter un navigateur sur une autre machine,
exécutez un **hôte de nœud** sur la machine du navigateur et maintenez les deux sur le même tailnet.
La Gateway transmettra les actions du navigateur au nœud ; aucun serveur de contrôle séparé ni URL Serve n’est nécessaire.

Évitez Funnel pour le contrôle du navigateur ; traitez l’appairage des nœuds comme un accès opérateur.

## Prérequis et limites Tailscale

- Serve requiert que HTTPS soit activé pour votre tailnet ; la CLI vous y invite s’il manque.
- Serve injecte des en-têtes d’identité Tailscale ; Funnel ne le fait pas.
- Funnel requiert Tailscale v1.38.3+, MagicDNS, HTTPS activé et un attribut de nœud funnel.
- Funnel ne prend en charge que les ports `443`, `8443` et `10000` via TLS.
- Funnel sur macOS nécessite la variante open source de l’application Tailscale.

## En savoir plus

- Présentation de Tailscale Serve : https://tailscale.com/kb/1312/serve
- Commande `tailscale serve` : https://tailscale.com/kb/1242/tailscale-serve
- Présentation de Tailscale Funnel : https://tailscale.com/kb/1223/tailscale-funnel
- Commande `tailscale funnel` : https://tailscale.com/kb/1311/tailscale-funnel
