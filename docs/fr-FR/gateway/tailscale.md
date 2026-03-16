---
summary: "Tailscale Serve/Funnel intégré pour le tableau de bord Passerelle"
read_when:
  - Exposition de l'UI de contrôle Passerelle en dehors de localhost
  - Automatisation de l'accès tableau de bord tailnet ou public
title: "Tailscale"
---

# Tailscale (tableau de bord Passerelle)

OpenClaw peut auto-configurer Tailscale **Serve** (tailnet) ou **Funnel** (public) pour le tableau de bord Passerelle et le port WebSocket. Cela garde la Passerelle liée au loopback tandis que Tailscale fournit HTTPS, routage et (pour Serve) en-têtes d'identité.

## Modes

- `serve` : Serve tailnet-uniquement via `tailscale serve`. La passerelle reste sur `127.0.0.1`.
- `funnel` : HTTPS public via `tailscale funnel`. OpenClaw nécessite un mot de passe partagé.
- `off` : Défaut (pas d'automatisation Tailscale).

## Auth

Définissez `gateway.auth.mode` pour contrôler le handshake :

- `token` (défaut quand `OPENCLAW_GATEWAY_TOKEN` est défini)
- `password` (secret partagé via `OPENCLAW_GATEWAY_PASSWORD` ou config)

Lorsque `tailscale.mode = "serve"` et `gateway.auth.allowTailscale` est `true`, les requêtes proxy Serve valides peuvent s'authentifier via les en-têtes d'identité Tailscale (`tailscale-user-login`) sans fournir de token/mot de passe. OpenClaw vérifie l'identité en résolvant l'adresse `x-forwarded-for` via le daemon Tailscale local (`tailscale whois`) et en la comparant à l'en-tête avant de l'accepter. OpenClaw ne traite une requête comme Serve que lorsqu'elle arrive de loopback avec les en-têtes Tailscale `x-forwarded-for`, `x-forwarded-proto` et `x-forwarded-host`.
Pour exiger des credentials explicites, définissez `gateway.auth.allowTailscale: false` ou forcez `gateway.auth.mode: "password"`.

## Exemples de config

### Tailnet-uniquement (Serve)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

Ouvrez : `https://<magicdns>/` (ou votre `gateway.controlUi.basePath` configuré)

### Tailnet-uniquement (liaison à l'IP Tailnet)

Utilisez ceci lorsque vous voulez que la Passerelle écoute directement sur l'IP Tailnet (pas de Serve/Funnel).

```json5
{
  gateway: {
    bind: "tailnet",
    auth: { mode: "token", token: "your-token" },
  },
}
```

Connectez-vous depuis un autre appareil Tailnet :

- UI de contrôle : `http://<tailscale-ip>:18789/`
- WebSocket : `ws://<tailscale-ip>:18789`

Note : loopback (`http://127.0.0.1:18789`) ne **fonctionnera pas** dans ce mode.

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

Préférez `OPENCLAW_GATEWAY_PASSWORD` plutôt que de committer un mot de passe sur disque.

## Exemples CLI

```bash
openclaw gateway --tailscale serve
openclaw gateway --tailscale funnel --auth password
```

## Notes

- Tailscale Serve/Funnel nécessite que le CLI `tailscale` soit installé et connecté.
- `tailscale.mode: "funnel"` refuse de démarrer sauf si le mode auth est `password` pour éviter l'exposition publique.
- Définissez `gateway.tailscale.resetOnExit` si vous voulez qu'OpenClaw annule la configuration `tailscale serve` ou `tailscale funnel` à l'arrêt.
- `gateway.bind: "tailnet"` est une liaison Tailnet directe (pas de HTTPS, pas de Serve/Funnel).
- `gateway.bind: "auto"` préfère loopback ; utilisez `tailnet` si vous voulez Tailnet-uniquement.
- Serve/Funnel n'exposent que **l'UI de contrôle Passerelle + WS**. Les nœuds se connectent via le même point de terminaison WS Passerelle, donc Serve peut fonctionner pour l'accès nœud.

## Contrôle navigateur (Passerelle distante + navigateur local)

Si vous exécutez la Passerelle sur une machine mais voulez piloter un navigateur sur une autre machine, exécutez un **hôte nœud** sur la machine navigateur et gardez les deux sur le même tailnet. La Passerelle proxifiera les actions navigateur vers le nœud ; pas besoin de serveur de contrôle séparé ou URL Serve.

Évitez Funnel pour le contrôle navigateur ; traitez l'appairage nœud comme l'accès opérateur.

## Prérequis et limites Tailscale

- Serve nécessite HTTPS activé pour votre tailnet ; le CLI invite s'il manque.
- Serve injecte des en-têtes d'identité Tailscale ; Funnel ne le fait pas.
- Funnel nécessite Tailscale v1.38.3+, MagicDNS, HTTPS activé et un attribut nœud funnel.
- Funnel ne supporte que les ports `443`, `8443` et `10000` sur TLS.
- Funnel sur macOS nécessite la variante d'app Tailscale open-source.

## En savoir plus

- Aperçu Tailscale Serve : [https://tailscale.com/kb/1312/serve](https://tailscale.com/kb/1312/serve)
- Commande `tailscale serve` : [https://tailscale.com/kb/1242/tailscale-serve](https://tailscale.com/kb/1242/tailscale-serve)
- Aperçu Tailscale Funnel : [https://tailscale.com/kb/1223/tailscale-funnel](https://tailscale.com/kb/1223/tailscale-funnel)
- Commande `tailscale funnel` : [https://tailscale.com/kb/1311/tailscale-funnel](https://tailscale.com/kb/1311/tailscale-funnel)
