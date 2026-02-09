---
summary: "Integração com a API de Bots do Telegram via grammY, com notas de configuração"
read_when:
  - Trabalhando em fluxos do Telegram ou grammY
title: grammY
---

# Integração grammY (API de Bots do Telegram)

# Por que grammY

- Cliente da API de Bots com foco em TS, com helpers integrados para long-poll e webhook, middleware, tratamento de erros e limitador de taxa.
- Helpers de mídia mais limpos do que implementar fetch + FormData manualmente; suporta todos os métodos da API de Bots.
- Extensível: suporte a proxy via fetch customizado, middleware de sessão (opcional), contexto com tipagem segura.

# O que entregamos

- **Caminho único de cliente:** a implementação baseada em fetch foi removida; grammY agora é o único cliente do Telegram (envio + gateway), com o throttler do grammY habilitado por padrão.
- **Gateway:** `monitorTelegramProvider` cria um `Bot` do grammY, conecta o gating de menções/lista de permissões, download de mídia via `getFile`/`download`, e entrega respostas com `sendMessage/sendPhoto/sendVideo/sendAudio/sendDocument`. Suporta long-poll ou webhook via `webhookCallback`.
- **Proxy:** o `channels.telegram.proxy` opcional usa `undici.ProxyAgent` por meio do `client.baseFetch` do grammY.
- **Suporte a webhook:** `webhook-set.ts` encapsula `setWebhook/deleteWebhook`; `webhook.ts` hospeda o callback com health check + desligamento gracioso. O Gateway habilita o modo webhook quando `channels.telegram.webhookUrl` + `channels.telegram.webhookSecret` estão definidos (caso contrário, usa long-poll).
- **Sessões:** chats diretos colapsam na sessão principal do agente (`agent:<agentId>:<mainKey>`); grupos usam `agent:<agentId>:telegram:group:<chatId>`; as respostas retornam para o mesmo canal.
- **Parâmetros de configuração:** `channels.telegram.botToken`, `channels.telegram.dmPolicy`, `channels.telegram.groups` (padrões de lista de permissões + menção), `channels.telegram.allowFrom`, `channels.telegram.groupAllowFrom`, `channels.telegram.groupPolicy`, `channels.telegram.mediaMaxMb`, `channels.telegram.linkPreview`, `channels.telegram.proxy`, `channels.telegram.webhookSecret`, `channels.telegram.webhookUrl`.
- **Streaming de rascunho:** o `channels.telegram.streamMode` opcional usa `sendMessageDraft` em chats privados por tópico (API de Bots 9.3+). Isso é separado do streaming em blocos do canal.
- **Testes:** mocks do grammY cobrem DM + gating de menções em grupos e envio de saída; mais fixtures de mídia/webhook ainda são bem-vindas.

Perguntas em aberto

- Plugins opcionais do grammY (throttler) se começarmos a receber 429 da API de Bots.
- Adicionar mais testes estruturados de mídia (figurinhas, mensagens de voz).
- Tornar a porta de escuta do webhook configurável (atualmente fixa em 8787, a menos que seja conectada via gateway).
