---
summary: "Surveiller l'expiration OAuth pour les fournisseurs de modèles"
read_when:
  - Configurer la surveillance d'expiration d'authentification ou les alertes
  - Automatiser les vérifications de rafraîchissement OAuth Claude Code / Codex
title: "Surveillance d'authentification"
---

# Surveillance d'authentification

OpenClaw expose la santé d'expiration OAuth via `openclaw models status`. Utilisez cela pour
l'automatisation et les alertes ; les scripts sont des extras optionnels pour les flux de travail téléphoniques.

## Préféré : vérification CLI (portable)

```bash
openclaw models status --check
```

Codes de sortie :

- `0` : OK
- `1` : identifiants expirés ou manquants
- `2` : expire bientôt (dans les 24h)

Cela fonctionne dans cron/systemd et ne nécessite aucun script supplémentaire.

## Scripts optionnels (ops / flux de travail téléphoniques)

Ceux-ci vivent sous `scripts/` et sont **optionnels**. Ils supposent un accès SSH à l'hôte
de passerelle et sont ajustés pour systemd + Termux.

- `scripts/claude-auth-status.sh` utilise maintenant `openclaw models status --json` comme
  source de vérité (repli vers des lectures de fichiers directes si la CLI n'est pas disponible),
  donc gardez `openclaw` sur `PATH` pour les timers.
- `scripts/auth-monitor.sh` : cible de timer cron/systemd ; envoie des alertes (ntfy ou téléphone).
- `scripts/systemd/openclaw-auth-monitor.{service,timer}` : timer utilisateur systemd.
- `scripts/claude-auth-status.sh` : vérificateur d'authentification Claude Code + OpenClaw (full/json/simple).
- `scripts/mobile-reauth.sh` : flux de ré-authentification guidé via SSH.
- `scripts/termux-quick-auth.sh` : widget à un tap statut + ouvre URL d'authentification.
- `scripts/termux-auth-widget.sh` : flux de widget guidé complet.
- `scripts/termux-sync-widget.sh` : synchronise les identifiants Claude Code → OpenClaw.

Si vous n'avez pas besoin d'automatisation téléphonique ou de timers systemd, sautez ces scripts.
