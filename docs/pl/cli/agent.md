---
summary: "Referencja CLI dla `openclaw agent` (wysłanie jednej tury agenta przez Gateway)"
read_when:
  - Chcesz uruchomić jedną turę agenta ze skryptów (opcjonalnie dostarczyć odpowiedź)
title: "agent"
---

# `openclaw agent`

Uruchom jedną turę agenta przez Gateway (użyj `--local` dla trybu osadzonego).
Użyj `--agent <id>`, aby bezpośrednio wskazać skonfigurowanego agenta.

Powiązane:

- Narzędzie Agent send: [Agent send](/tools/agent-send)

## Przykłady

```bash
openclaw agent --to +15555550123 --message "status update" --deliver
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```
