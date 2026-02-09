---
summary: "Adaptadores RPC para CLIs externas (signal-cli, imsg legado) e padrões de gateway"
read_when:
  - Ao adicionar ou alterar integrações de CLI externas
  - Ao depurar adaptadores RPC (signal-cli, imsg)
title: "Adaptadores RPC"
---

# Adaptadores RPC

O OpenClaw integra CLIs externas via JSON-RPC. Dois padrões são usados atualmente.

## Padrão A: daemon HTTP (signal-cli)

- `signal-cli` é executado como um daemon com JSON-RPC sobre HTTP.
- O stream de eventos é SSE (`/api/v1/events`).
- Verificação de integridade: `/api/v1/check`.
- O OpenClaw controla o ciclo de vida quando `channels.signal.autoStart=true`.

Veja [Signal](/channels/signal) para configuração e endpoints.

## Padrão B: processo filho via stdio (legado: imsg)

> **Nota:** Para novas configurações do iMessage, use [BlueBubbles](/channels/bluebubbles) em vez disso.

- O OpenClaw inicia `imsg rpc` como um processo filho (integração legada do iMessage).
- O JSON-RPC é delimitado por linhas via stdin/stdout (um objeto JSON por linha).
- Sem porta TCP; nenhum daemon é necessário.

Métodos principais usados:

- `watch.subscribe` → notificações (`method: "message"`)
- `watch.unsubscribe`
- `send`
- `chats.list` (sondagem/diagnósticos)

Veja [iMessage](/channels/imessage) para configuração legada e endereçamento (`chat_id` preferido).

## Diretrizes do adaptador

- O Gateway controla o processo (início/parada vinculados ao ciclo de vida do provedor).
- Mantenha os clientes RPC resilientes: timeouts, reinício ao encerrar.
- Prefira IDs estáveis (por exemplo, `chat_id`) em vez de strings de exibição.
