---
summary: "Execuções diretas do CLI `openclaw agent` (com entrega opcional)"
read_when:
  - Ao adicionar ou modificar o entrypoint do CLI do agente
title: "Envio do Agente"
---

# `openclaw agent` (execuções diretas do agente)

`openclaw agent` executa um único turno do agente sem precisar de uma mensagem de chat de entrada.
Por padrão, passa **pelo Gateway**; adicione `--local` para forçar o
runtime incorporado na máquina atual.

## Comportamento

- Obrigatório: `--message <text>`
- Seleção de sessão:
  - `--to <dest>` deriva a chave de sessão (alvos de grupo/canal preservam o isolamento; chats diretos colapsam para `main`), **ou**
  - `--session-id <id>` reutiliza uma sessão existente por id, **ou**
  - `--agent <id>` direciona diretamente para um agente configurado (usa a chave de sessão `main` desse agente)
- Executa o mesmo runtime de agente incorporado das respostas de entrada normais.
- Flags de pensamento/verboso persistem no armazenamento da sessão.
- Saída:
  - padrão: imprime o texto da resposta (mais linhas `MEDIA:<url>`)
  - `--json`: imprime payload estruturado + metadados
- Entrega opcional de volta a um canal com `--deliver` + `--channel` (os formatos de destino correspondem a `openclaw message --target`).
- Use `--reply-channel`/`--reply-to`/`--reply-account` para substituir a entrega sem alterar a sessão.

Se o Gateway estiver inacessível, o CLI **recorre** à execução local incorporada.

## Exemplos

```bash
openclaw agent --to +15555550123 --message "status update"
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --to +15555550123 --message "Trace logs" --verbose on --json
openclaw agent --to +15555550123 --message "Summon reply" --deliver
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```

## Flags

- `--local`: executar localmente (requer chaves de API do provedor de modelo no seu shell)
- `--deliver`: enviar a resposta para o canal escolhido
- `--channel`: canal de entrega (`whatsapp|telegram|discord|googlechat|slack|signal|imessage`, padrão: `whatsapp`)
- `--reply-to`: substituição do destino de entrega
- `--reply-channel`: substituição do canal de entrega
- `--reply-account`: substituição do id da conta de entrega
- `--thinking <off|minimal|low|medium|high|xhigh>`: persistir nível de pensamento (somente modelos GPT-5.2 + Codex)
- `--verbose <on|full|off>`: persistir nível verboso
- `--timeout <seconds>`: substituir o timeout do agente
- `--json`: saída em JSON estruturado
