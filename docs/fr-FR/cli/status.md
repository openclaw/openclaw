---
summary: "Référence CLI pour `openclaw status` (diagnostics, sondes, instantanés d'utilisation)"
read_when:
  - Vous voulez un diagnostic rapide de la santé du canal + destinataires de session récents
  - Vous voulez un statut "all" collable pour le débogage
title: "status"
---

# `openclaw status`

Diagnostics pour les canaux + sessions.

```bash
openclaw status
openclaw status --all
openclaw status --deep
openclaw status --usage
```

Notes :

- `--deep` exécute des sondes en direct (WhatsApp Web + Telegram + Discord + Google Chat + Slack + Signal).
- La sortie inclut des magasins de session par agent quand plusieurs agents sont configurés.
- L'aperçu inclut l'état d'installation/runtime du service hôte de Passerelle + nœud quand disponible.
- L'aperçu inclut le canal de mise à jour + SHA git (pour les checkouts source).
- Les infos de mise à jour apparaissent dans l'Aperçu ; si une mise à jour est disponible, status affiche un conseil pour exécuter `openclaw update` (voir [Mise à jour](/fr-FR/install/updating)).
