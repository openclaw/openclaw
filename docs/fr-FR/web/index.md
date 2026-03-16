---
summary: "Surfaces web de Passerelle : UI de contrôle, modes de liaison et sécurité"
read_when:
  - Vous voulez accéder à la Passerelle via Tailscale
  - Vous voulez l'UI de contrôle navigateur et l'édition de config
title: "Web"
---

# Web (Passerelle)

La Passerelle sert une petite **UI de contrôle navigateur** (Vite + Lit) depuis le même port que le WebSocket de Passerelle :

- par défaut : `http://<hôte>:18789/`
- préfixe optionnel : définir `gateway.controlUi.basePath` (ex. `/openclaw`)

Les capacités vivent dans [UI de contrôle](/fr-FR/web/control-ui).
Cette page se concentre sur les modes de liaison, la sécurité et les surfaces orientées web.

## Webhooks

Quand `hooks.enabled=true`, la Passerelle expose aussi un petit point de terminaison webhook sur le même serveur HTTP.
Voir [Configuration de passerelle](/fr-FR/gateway/configuration) → `hooks` pour l'auth + charges utiles.

## Config (activée par défaut)

L'UI de contrôle est **activée par défaut** quand les assets sont présents (`dist/control-ui`).
Vous pouvez la contrôler via config :

```json5
{
  gateway: {
    controlUi: { enabled: true, basePath: "/openclaw" }, // basePath optionnel
  },
}
```

## Accès Tailscale

### Serve intégré (recommandé)

Gardez la Passerelle sur loopback et laissez Tailscale Serve la proxyfier :

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

Puis démarrez la passerelle :

```bash
openclaw gateway
```

Ouvrez :

- `https://<magicdns>/` (ou votre `gateway.controlUi.basePath` configuré)

### Liaison tailnet + token

```json5
{
  gateway: {
    bind: "tailnet",
    controlUi: { enabled: true },
    auth: { mode: "token", token: "votre-token" },
  },
}
```

Puis démarrez la passerelle (token requis pour les liaisons non-loopback) :

```bash
openclaw gateway
```

Ouvrez :

- `http://<tailscale-ip>:18789/` (ou votre `gateway.controlUi.basePath` configuré)

### Internet public (Funnel)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password" }, // ou OPENCLAW_GATEWAY_PASSWORD
  },
}
```

## Notes de sécurité

- L'authentification de Passerelle est requise par défaut (token/mot de passe ou en-têtes d'identité Tailscale).
- Les liaisons non-loopback **nécessitent** toujours un token/mot de passe partagé (`gateway.auth` ou env).
- L'assistant génère un token de passerelle par défaut (même sur loopback).
- L'UI envoie `connect.params.auth.token` ou `connect.params.auth.password`.
- L'UI de contrôle envoie des en-têtes anti-clickjacking et n'accepte que les connexions
  websocket de navigateur de même origine sauf si `gateway.controlUi.allowedOrigins` est défini.
- Avec Serve, les en-têtes d'identité Tailscale peuvent satisfaire l'auth quand
  `gateway.auth.allowTailscale` est `true` (pas de token/mot de passe requis). Définissez
  `gateway.auth.allowTailscale: false` pour exiger des identifiants explicites. Voir
  [Tailscale](/fr-FR/gateway/tailscale) et [Sécurité](/fr-FR/gateway/security).
- `gateway.tailscale.mode: "funnel"` nécessite `gateway.auth.mode: "password"` (mot de passe partagé).

## Construire l'UI

La Passerelle sert les fichiers statiques depuis `dist/control-ui`. Construisez-les avec :

```bash
pnpm ui:build # auto-installe les dépendances UI au premier lancement
```
