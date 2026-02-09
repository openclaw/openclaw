---
summary: "Ingresso por webhook para despertar e execuções isoladas de agentes"
read_when:
  - Adicionar ou alterar endpoints de webhook
  - Conectar sistemas externos ao OpenClaw
title: "Webhooks"
---

# Webhooks

O Gateway pode expor um pequeno endpoint HTTP de webhook para gatilhos externos.

## Ativar

```json5
{
  hooks: {
    enabled: true,
    token: "shared-secret",
    path: "/hooks",
  },
}
```

Notas:

- `hooks.token` é obrigatório quando `hooks.enabled=true`.
- `hooks.path` tem como padrão `/hooks`.

## Autenticação

Toda solicitação deve incluir o token do hook. Prefira cabeçalhos:

- `Authorization: Bearer <token>` (recomendado)
- `x-openclaw-token: <token>`
- `?token=<token>` (obsoleto; registra um aviso e será removido em uma futura versão major)

## Endpoints

### `POST /hooks/wake`

Payload:

```json
{ "text": "System line", "mode": "now" }
```

- `text` **obrigatório** (string): A descrição do evento (por exemplo, "Novo e-mail recebido").
- `mode` opcional (`now` | `next-heartbeat`): Se deve acionar um heartbeat imediato (padrão `now`) ou aguardar a próxima verificação periódica.

Efeito:

- Enfileira um evento de sistema para a sessão **principal**
- Se `mode=now`, aciona um heartbeat imediato

### `POST /hooks/agent`

Payload:

```json
{
  "message": "Run this",
  "name": "Email",
  "sessionKey": "hook:email:msg-123",
  "wakeMode": "now",
  "deliver": true,
  "channel": "last",
  "to": "+15551234567",
  "model": "openai/gpt-5.2-mini",
  "thinking": "low",
  "timeoutSeconds": 120
}
```

- `message` **obrigatório** (string): O prompt ou mensagem para o agente processar.
- `name` opcional (string): Nome legível para humanos do hook (por exemplo, "GitHub"), usado como prefixo nos resumos de sessão.
- `sessionKey` opcional (string): A chave usada para identificar a sessão do agente. O padrão é um `hook:<uuid>` aleatório. Usar uma chave consistente permite uma conversa de múltiplos turnos dentro do contexto do hook.
- `wakeMode` opcional (`now` | `next-heartbeat`): Se deve acionar um heartbeat imediato (padrão `now`) ou aguardar a próxima verificação periódica.
- `deliver` opcional (boolean): Se `true`, a resposta do agente será enviada ao canal de mensagens. O padrão é `true`. Respostas que são apenas reconhecimentos de heartbeat são automaticamente ignoradas.
- `channel` opcional (string): O canal de mensagens para entrega. Um de: `last`, `whatsapp`, `telegram`, `discord`, `slack`, `mattermost` (plugin), `signal`, `imessage`, `msteams`. O padrão é `last`.
- `to` opcional (string): O identificador do destinatário para o canal (por exemplo, número de telefone para WhatsApp/Signal, ID do chat para Telegram, ID do canal para Discord/Slack/Mattermost (plugin), ID da conversa para MS Teams). O padrão é o último destinatário na sessão principal.
- `model` opcional (string): Substituição de modelo (por exemplo, `anthropic/claude-3-5-sonnet` ou um alias). Deve estar na lista de modelos permitidos se houver restrição.
- `thinking` opcional (string): Substituição do nível de pensamento (por exemplo, `low`, `medium`, `high`).
- `timeoutSeconds` opcional (number): Duração máxima da execução do agente em segundos.

Efeito:

- Executa um turno de agente **isolado** (chave de sessão própria)
- Sempre publica um resumo na sessão **principal**
- Se `wakeMode=now`, aciona um heartbeat imediato

### `POST /hooks/<name>` (mapeado)

Nomes de hooks personalizados são resolvidos via `hooks.mappings` (ver configuração). Um mapeamento pode
transformar payloads arbitrários em ações `wake` ou `agent`, com templates opcionais ou
transformações de código.

Opções de mapeamento (resumo):

- `hooks.presets: ["gmail"]` habilita o mapeamento integrado do Gmail.
- `hooks.mappings` permite definir `match`, `action` e templates na configuração.
- `hooks.transformsDir` + `transform.module` carrega um módulo JS/TS para lógica personalizada.
- Use `match.source` para manter um endpoint genérico de ingestão (roteamento orientado por payload).
- Transformações em TS exigem um loader de TS (por exemplo, `bun` ou `tsx`) ou `.js` pré-compilado em tempo de execução.
- Defina `deliver: true` + `channel`/`to` nos mapeamentos para rotear respostas para uma superfície de chat
  (`channel` tem como padrão `last` e faz fallback para WhatsApp).
- `allowUnsafeExternalContent: true` desativa o invólucro externo de segurança de conteúdo para esse hook
  (perigoso; apenas para fontes internas confiáveis).
- `openclaw webhooks gmail setup` grava configuração `hooks.gmail` para `openclaw webhooks gmail run`.
  Veja [Gmail Pub/Sub](/automation/gmail-pubsub) para o fluxo completo de watch do Gmail.

## Respostas

- `200` para `/hooks/wake`
- `202` para `/hooks/agent` (execução assíncrona iniciada)
- `401` em falha de autenticação
- `400` em payload inválido
- `413` em payloads grandes demais

## Exemplos

```bash
curl -X POST http://127.0.0.1:18789/hooks/wake \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"text":"New email received","mode":"now"}'
```

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'x-openclaw-token: SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarize inbox","name":"Email","wakeMode":"next-heartbeat"}'
```

### Usar um modelo diferente

Adicione `model` ao payload do agente (ou ao mapeamento) para substituir o modelo nessa execução:

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'x-openclaw-token: SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarize inbox","name":"Email","model":"openai/gpt-5.2-mini"}'
```

Se você impuser `agents.defaults.models`, certifique-se de que o modelo de substituição esteja incluído lá.

```bash
curl -X POST http://127.0.0.1:18789/hooks/gmail \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"source":"gmail","messages":[{"from":"Ada","subject":"Hello","snippet":"Hi"}]}'
```

## Segurança

- Mantenha endpoints de hook atrás de local loopback, tailnet ou um proxy reverso confiável.
- Use um token de hook dedicado; não reutilize tokens de autenticação do gateway.
- Evite incluir payloads brutos sensíveis nos logs de webhook.
- As cargas de gancho são tratadas como não confiáveis e dentro de limites de segurança por padrão.
  Payloads de hook são tratados como não confiáveis e envolvidos por limites de segurança por padrão.
  Se você precisar desativar isso para um hook específico, defina `allowUnsafeExternalContent: true`
  no mapeamento desse hook (perigoso).
