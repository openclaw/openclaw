---
summary: "Surveiller l’expiration OAuth pour les fournisseurs de modèles"
read_when:
  - Mise en place de la surveillance ou d’alertes d’expiration d’authentification
  - Automatisation des vérifications de rafraîchissement OAuth de Claude Code / Codex
title: "Surveillance de l’authentification"
---

# Surveillance de l’authentification

OpenClaw expose l’état de santé de l’expiration OAuth via `openclaw models status`. Utilisez‑le pour
l’automatisation et les alertes ; les scripts sont des options facultatives pour les workflows sur téléphone.

## Préféré : vérification via la CLI (portable)

```bash
openclaw models status --check
```

Codes de sortie :

- `0` : OK
- `1` : identifiants expirés ou manquants
- `2` : expiration imminente (dans les 24 h)

Cela fonctionne avec cron/systemd et ne nécessite aucun script supplémentaire.

## Scripts optionnels (ops / workflows téléphone)

Ils se trouvent sous `scripts/` et sont **optionnels**. Ils supposent un accès SSH à l’hôte de la Gateway (passerelle) et sont optimisés pour systemd + Termux.

- `scripts/claude-auth-status.sh` utilise désormais `openclaw models status --json` comme
  source de vérité (avec repli sur des lectures directes de fichiers si la CLI est indisponible),
  conservez donc `openclaw` sur `PATH` pour les minuteurs.
- `scripts/auth-monitor.sh` : cible de minuteur cron/systemd ; envoie des alertes (ntfy ou téléphone).
- `scripts/systemd/openclaw-auth-monitor.{service,timer}` : minuteur utilisateur systemd.
- `scripts/claude-auth-status.sh` : vérificateur d’authentification Claude Code + OpenClaw (complet/json/simple).
- `scripts/mobile-reauth.sh` : flux de ré‑authentification guidé via SSH.
- `scripts/termux-quick-auth.sh` : widget d’état en un tap + ouverture de l’URL d’authentification.
- `scripts/termux-auth-widget.sh` : flux de widget guidé complet.
- `scripts/termux-sync-widget.sh` : synchronisation des identifiants Claude Code → OpenClaw.

Si vous n’avez pas besoin de l’automatisation sur téléphone ou des minuteurs systemd, ignorez ces scripts.
