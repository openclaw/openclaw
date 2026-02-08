---
summary: "Reference CLI pour `openclaw status` (diagnostics, sondes, instantanes d'utilisation)"
read_when:
  - Vous voulez un diagnostic rapide de l'etat des canaux et des destinataires de sessions recentes
  - Vous voulez un etat « tout-en-un » copiable pour le debogage
title: "statut"
x-i18n:
  source_path: cli/status.md
  source_hash: 2bbf5579c48034fc
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T07:01:02Z
---

# `openclaw status`

Diagnostics pour les canaux + les sessions.

```bash
openclaw status
openclaw status --all
openclaw status --deep
openclaw status --usage
```

Notes :

- `--deep` execute des sondes en direct (WhatsApp Web + Telegram + Discord + Google Chat + Slack + Signal).
- La sortie inclut les stockages de session par agent lorsque plusieurs agents sont configures.
- La vue d'ensemble inclut l'etat d'installation et d'execution du service hote du nœud et du Gateway (passerelle) lorsque disponible.
- La vue d'ensemble inclut le canal de mise a jour + le SHA git (pour les installations depuis les sources).
- Les informations de mise a jour apparaissent dans la vue d'ensemble ; si une mise a jour est disponible, le statut affiche un indice pour executer `openclaw update` (voir [Updating](/install/updating)).
