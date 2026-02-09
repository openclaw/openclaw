---
summary: "Referência da CLI para `openclaw status` (diagnósticos, sondagens, snapshots de uso)"
read_when:
  - Voce quer um diagnóstico rápido da saúde dos canais + destinatários de sessões recentes
  - Voce quer um status “all” colável para depuração
title: "status"
---

# `openclaw status`

Diagnósticos para canais + sessões.

```bash
openclaw status
openclaw status --all
openclaw status --deep
openclaw status --usage
```

Notas:

- `--deep` executa sondagens ao vivo (WhatsApp Web + Telegram + Discord + Google Chat + Slack + Signal).
- A saída inclui armazenamentos de sessão por agente quando vários agentes estão configurados.
- A visão geral inclui o status de instalação/execução do serviço do Gateway + do host do nó quando disponível.
- A visão geral inclui o canal de atualização + o SHA do git (para checkouts de código-fonte).
- As informações de atualização aparecem na Visão geral; se uma atualização estiver disponível, o status imprime uma dica para executar `openclaw update` (veja [Updating](/install/updating)).
