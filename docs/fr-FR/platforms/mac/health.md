---
summary: "Comment app macOS rapporte états santé gateway/Baileys"
read_when:
  - Débogage indicateurs santé app mac
title: "Checks Santé"
---

# Checks Santé sur macOS

Comment voir si canal lié est sain depuis app menu bar.

## Menu Bar

- Point statut reflète maintenant santé Baileys :
  - Vert : lié + socket ouvert récemment.
  - Orange : connexion/retry.
  - Rouge : logged out ou probe échoué.
- Ligne secondaire lit "lié · auth 12m" ou montre raison échec.
- Item menu "Run Health Check" déclenche probe on-demand.

## Réglages

- Onglet General gagne carte Health montrant : âge auth lié, chemin/count session-store, temps dernier check, dernier error/code statut et boutons pour Run Health Check / Reveal Logs.
- Utilise snapshot caché donc UI charge instantanément et tombe back gracieusement quand offline.
- **Onglet Channels** surface statut canal + contrôles pour WhatsApp/Telegram (QR login, logout, probe, dernier disconnect/error).

## Comment probe fonctionne

- App exécute `openclaw health --json` via `ShellExecutor` toutes les ~60s et on demand. Probe charge creds et rapporte statut sans envoyer messages.
- Cache dernier bon snapshot et dernière erreur séparément pour éviter flicker ; montrer timestamp de chacun.

## En cas de doute

- Vous pouvez toujours utiliser flux CLI dans [Santé Gateway](/fr-FR/gateway/health) (`openclaw status`, `openclaw status --deep`, `openclaw health --json`) et tail `/tmp/openclaw/openclaw-*.log` pour `web-heartbeat` / `web-reconnect`.

Voir aussi :

- [App macOS](/fr-FR/platforms/macos)
- [Status](/fr-FR/cli/status)
- [Dépannage](/fr-FR/gateway/troubleshooting)
