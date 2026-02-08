---
summary: "Référence CLI pour `openclaw agent` (envoyer un tour d’agent via la Gateway (passerelle))"
read_when:
  - Vous souhaitez exécuter un tour d’agent depuis des scripts (avec livraison optionnelle de la réponse)
title: "agent"
x-i18n:
  source_path: cli/agent.md
  source_hash: dcf12fb94e207c68
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T07:00:46Z
---

# `openclaw agent`

Exécutez un tour d’agent via la Gateway (passerelle) (utilisez `--local` pour l’intégration).
Utilisez `--agent <id>` pour cibler directement un agent configuré.

Connexe :

- Outil d’envoi d’agent : [Agent send](/tools/agent-send)

## Exemples

```bash
openclaw agent --to +15555550123 --message "status update" --deliver
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```
