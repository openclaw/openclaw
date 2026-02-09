---
summary: "Surfaces web de la Gateway : interface de controle, modes de liaison et securite"
read_when:
  - Vous voulez acceder a la Gateway via Tailscale
  - Vous voulez l’interface de controle dans le navigateur et l’edition de la configuration
title: "Web"
---

# Web (Gateway)

La Gateway fournit une petite **interface de controle dans le navigateur** (Vite + Lit) depuis le meme port que le WebSocket de la Gateway :

- par defaut : `http://<host>:18789/`
- prefixe optionnel : definir `gateway.controlUi.basePath` (par ex. `/openclaw`)

Les fonctionnalites se trouvent dans [Control UI](/web/control-ui).
Cette page se concentre sur les modes de liaison, la securite et les surfaces exposees au web.

## Webhooks

Lorsque `hooks.enabled=true`, la Gateway expose egalement un petit point d’entree webhook sur le meme serveur HTTP.
Voir [Configuration de la Gateway](/gateway/configuration) → `hooks` pour l’authentification et les charges utiles.

## Config (activee par defaut)

L’interface de controle est **activee par defaut** lorsque les ressources sont presentes (`dist/control-ui`).
Vous pouvez la controler via la configuration :

```json5
{
  gateway: {
    controlUi: { enabled: true, basePath: "/openclaw" }, // basePath optional
  },
}
```

## Acces Tailscale

### Serve integre (recommande)

Gardez la Gateway sur le loopback et laissez Tailscale Serve la proxifier :

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

Puis demarrez la gateway :

```bash
openclaw gateway
```

Ouvrez :

- `https://<magicdns>/` (ou votre `gateway.controlUi.basePath` configure)

### Liaison Tailnet + jeton

```json5
{
  gateway: {
    bind: "tailnet",
    controlUi: { enabled: true },
    auth: { mode: "token", token: "your-token" },
  },
}
```

Puis demarrez la gateway (jeton requis pour les liaisons non-loopback) :

```bash
openclaw gateway
```

Ouvrez :

- `http://<tailscale-ip>:18789/` (ou votre `gateway.controlUi.basePath` configure)

### Internet public (Funnel)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password" }, // or OPENCLAW_GATEWAY_PASSWORD
  },
}
```

## Notes de securite

- L’authentification de la Gateway est requise par defaut (jeton/mot de passe ou en-tetes d’identite Tailscale).
- Les liaisons non-loopback **necessitent** toujours un jeton/mot de passe partage (`gateway.auth` ou variable d’environnement).
- L'assistant génère un jeton de passerelle par défaut (même sur le rebouclage).
- L’interface envoie `connect.params.auth.token` ou `connect.params.auth.password`.
- L’interface de controle envoie des en-tetes anti-clickjacking et n’accepte que des connexions WebSocket
  navigateur de meme origine, sauf si `gateway.controlUi.allowedOrigins` est defini.
- Avec Serve, les en-tetes d’identite Tailscale peuvent satisfaire l’authentification lorsque
  `gateway.auth.allowTailscale` est `true` (aucun jeton/mot de passe requis). Definissez
  `gateway.auth.allowTailscale: false` pour exiger des identifiants explicites. Voir
  [Tailscale](/gateway/tailscale) et [Securite](/gateway/security).
- `gateway.tailscale.mode: "funnel"` requiert `gateway.auth.mode: "password"` (mot de passe partage).

## Construction de l’interface

La Gateway sert des fichiers statiques depuis `dist/control-ui`. Construisez-les avec :

```bash
pnpm ui:build # auto-installs UI deps on first run
```
