---
summary: "Gateway üzerinden `openclaw agent` için CLI başvurusu (Gateway aracılığıyla tek bir ajan turu gönderme)"
read_when:
  - Betiklerden tek bir ajan turu çalıştırmak istediğinizde (isteğe bağlı olarak yanıtı iletme)
title: "cli/agent.md"
---

# `openclaw agent`

Gateway üzerinden bir ajan turu çalıştırın (gömülü kullanım için `--local` kullanın).
Yapılandırılmış bir ajanı doğrudan hedeflemek için `--agent <id>` kullanın.

İlgili:

- Agent send aracı: [Agent send](/tools/agent-send)

## Örnekler

```bash
openclaw agent --to +15555550123 --message "status update" --deliver
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```
