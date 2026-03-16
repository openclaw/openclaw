---
summary: "Référence CLI pour `openclaw agent` (envoyer un tour d'agent via la Passerelle)"
read_when:
  - Vous voulez exécuter un tour d'agent depuis des scripts (optionnellement livrer la réponse)
title: "agent"
---

# `openclaw agent`

Exécutez un tour d'agent via la Passerelle (utilisez `--local` pour intégré).
Utilisez `--agent <id>` pour cibler directement un agent configuré.

Connexe :

- Outil d'envoi d'agent : [Envoi d'agent](/fr-FR/tools/agent-send)

## Exemples

```bash
openclaw agent --to +15555550123 --message "mise à jour de statut" --deliver
openclaw agent --agent ops --message "Résumer les logs"
openclaw agent --session-id 1234 --message "Résumer la boîte de réception" --thinking medium
openclaw agent --agent ops --message "Générer un rapport" --deliver --reply-channel slack --reply-to "#reports"
```
