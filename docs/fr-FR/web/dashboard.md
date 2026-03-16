---
summary: "Accès et authentification au tableau de bord de Passerelle (UI de contrôle)"
read_when:
  - Changer l'authentification ou les modes d'exposition du tableau de bord
title: "Tableau de bord"
---

# Tableau de bord (UI de contrôle)

Le tableau de bord de Passerelle est l'UI de contrôle navigateur servie à `/` par défaut
(remplacer avec `gateway.controlUi.basePath`).

Ouverture rapide (Passerelle locale) :

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (ou [http://localhost:18789/](http://localhost:18789/))

Références clés :

- [UI de contrôle](/fr-FR/web/control-ui) pour l'utilisation et les capacités de l'UI.
- [Tailscale](/fr-FR/gateway/tailscale) pour l'automatisation Serve/Funnel.
- [Surfaces web](/fr-FR/web) pour les modes de liaison et les notes de sécurité.

L'authentification est appliquée à la poignée de main WebSocket via `connect.params.auth`
(token ou mot de passe). Voir `gateway.auth` dans [Configuration de passerelle](/fr-FR/gateway/configuration).

Note de sécurité : l'UI de contrôle est une **surface admin** (chat, config, approbations exec).
Ne l'exposez pas publiquement. L'UI stocke le token dans `localStorage` après le premier chargement.
Préférez localhost, Tailscale Serve, ou un tunnel SSH.

## Chemin rapide (recommandé)

- Après l'onboarding, la CLI ouvre automatiquement le tableau de bord et imprime un lien propre (non tokenisé).
- Rouvrir à tout moment : `openclaw dashboard` (copie le lien, ouvre le navigateur si possible, montre l'indice SSH si headless).
- Si l'UI demande l'authentification, collez le token depuis `gateway.auth.token` (ou `OPENCLAW_GATEWAY_TOKEN`) dans les paramètres de l'UI de contrôle.

## Bases du token (local vs distant)

- **Localhost** : ouvrez `http://127.0.0.1:18789/`.
- **Source du token** : `gateway.auth.token` (ou `OPENCLAW_GATEWAY_TOKEN`) ; l'UI stocke une copie dans localStorage après connexion.
- **Pas localhost** : utilisez Tailscale Serve (sans token si `gateway.auth.allowTailscale: true`), liaison tailnet avec un token, ou un tunnel SSH. Voir [Surfaces web](/fr-FR/web).

## Si vous voyez "unauthorized" / 1008

- Assurez-vous que la passerelle est accessible (local : `openclaw status` ; distant : tunnel SSH `ssh -N -L 18789:127.0.0.1:18789 user@host` puis ouvrez `http://127.0.0.1:18789/`).
- Récupérez le token depuis l'hôte de passerelle : `openclaw config get gateway.auth.token` (ou générez-en un : `openclaw doctor --generate-gateway-token`).
- Dans les paramètres du tableau de bord, collez le token dans le champ auth, puis connectez-vous.
