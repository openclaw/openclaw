---
summary: "Référence CLI pour `openclaw agent` (envoyer un tour d’agent via la Gateway (passerelle))"
read_when:
  - Vous souhaitez exécuter un tour d’agent depuis des scripts (avec livraison optionnelle de la réponse)
title: "agent"
---

# `openclaw agent`

Exécutez un tour d’agent via la Gateway (passerelle) (utilisez `--local` pour l’intégration).
Utilisez `--agent <id>` pour cibler directement un agent configuré.

Liens connexes :

- Outil d’envoi d’agent : [Agent send](/tools/agent-send)

## Exemples

```bash
openclaw agent --to +15555550123 --message "status update" --deliver
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```
