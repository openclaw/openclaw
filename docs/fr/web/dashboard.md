---
summary: "Accès et authentification du tableau de bord de la Gateway (UI de contrôle)"
read_when:
  - Modification des modes d’authentification ou d’exposition du tableau de bord
title: "Tableau de bord"
---

# Tableau de bord (UI de contrôle)

Le tableau de bord de la Gateway (passerelle) est l’UI de contrôle dans le navigateur, servie par défaut sur `/`
(remplaçable via `gateway.controlUi.basePath`).

Ouverture rapide (Gateway locale) :

- http://127.0.0.1:18789/ (ou http://localhost:18789/)

Références clés :

- [UI de contrôle](/web/control-ui) pour l’utilisation et les capacités de l’interface.
- [Tailscale](/gateway/tailscale) pour l’automatisation Serve/Funnel.
- [Surfaces web](/web) pour les modes de liaison et les notes de sécurité.

L’authentification est appliquée lors de la poignée de main WebSocket via `connect.params.auth`
(token ou mot de passe). Voir `gateway.auth` dans la [configuration de la Gateway](/gateway/configuration).

Note de sécurité : l’UI de contrôle est une **surface d’administration** (chat, configuration, validations d’exécution).
Ne l’exposez pas publiquement. L’UI stocke le token dans `localStorage` après le premier chargement.
Privilégiez localhost, Tailscale Serve ou un tunnel SSH.

## Voie rapide (recommandée)

- Après la prise en main, la CLI ouvre automatiquement le tableau de bord et affiche un lien propre (sans token).
- Réouverture à tout moment : `openclaw dashboard` (copie le lien, ouvre le navigateur si possible, affiche un indice SSH si sans interface).
- Si l’UI demande une authentification, collez le token depuis `gateway.auth.token` (ou `OPENCLAW_GATEWAY_TOKEN`) dans les paramètres de l’UI de contrôle.

## Bases des tokens (local vs distant)

- **Localhost** : ouvrez `http://127.0.0.1:18789/`.
- **Source du token** : `gateway.auth.token` (ou `OPENCLAW_GATEWAY_TOKEN`) ; l’UI en stocke une copie dans localStorage après la connexion.
- **Hors localhost** : utilisez Tailscale Serve (sans token si `gateway.auth.allowTailscale: true`), une liaison tailnet avec token, ou un tunnel SSH. Voir [Surfaces web](/web).

## Si vous voyez « unauthorized » / 1008

- Vérifiez que la gateway est joignable (local : `openclaw status` ; distant : tunnel SSH `ssh -N -L 18789:127.0.0.1:18789 user@host` puis ouvrez `http://127.0.0.1:18789/`).
- Récupérez le token depuis l’hôte de la gateway : `openclaw config get gateway.auth.token` (ou générez-en un : `openclaw doctor --generate-gateway-token`).
- Dans les paramètres du tableau de bord, collez le token dans le champ d’authentification, puis connectez-vous.
