---
summary: "Plano: adicionar o endpoint OpenResponses /v1/responses e descontinuar chat completions de forma limpa"
owner: "openclaw"
status: "draft"
last_updated: "2026-01-19"
title: "Plano do Gateway OpenResponses"
---

# Plano de Integração do Gateway OpenResponses

## Contexto

O Gateway OpenClaw atualmente expõe um endpoint mínimo de Chat Completions compatível com OpenAI em
`/v1/chat/completions` (veja [OpenAI Chat Completions](/gateway/openai-http-api)).

Open Responses é um padrão aberto de inferência baseado na API OpenAI Responses. Ele foi projetado
para fluxos de trabalho agentic e usa entradas baseadas em itens além de eventos semânticos de streaming. A especificação OpenResponses define `/v1/responses`, não `/v1/chat/completions`.

## Objetivos

- Adicionar um endpoint `/v1/responses` que siga a semântica do OpenResponses.
- Manter Chat Completions como uma camada de compatibilidade que seja fácil de desativar e, eventualmente, remover.
- Padronizar validação e parsing com schemas isolados e reutilizáveis.

## Não objetivos

- Paridade completa de recursos do OpenResponses na primeira etapa (imagens, arquivos, ferramentas hospedadas).
- Substituir a lógica interna de execução de agentes ou a orquestração de ferramentas.
- Alterar o comportamento existente de `/v1/chat/completions` durante a primeira fase.

## Resumo da Pesquisa

Fontes: OpenAPI do OpenResponses, site da especificação OpenResponses e o post do blog da Hugging Face.

Principais pontos extraídos:

- `POST /v1/responses` aceita campos `CreateResponseBody` como `model`, `input` (string ou
  `ItemParam[]`), `instructions`, `tools`, `tool_choice`, `stream`, `max_output_tokens` e
  `max_tool_calls`.
- `ItemParam` é uma união discriminada de:
  - itens `message` com papéis `system`, `developer`, `user`, `assistant`
  - `function_call` e `function_call_output`
  - `reasoning`
  - `item_reference`
- Respostas bem-sucedidas retornam um `ResponseResource` com itens `object: "response"`, `status` e
  `output`.
- O streaming usa eventos semânticos como:
  - `response.created`, `response.in_progress`, `response.completed`, `response.failed`
  - `response.output_item.added`, `response.output_item.done`
  - `response.content_part.added`, `response.content_part.done`
  - `response.output_text.delta`, `response.output_text.done`
- A especificação exige:
  - `Content-Type: text/event-stream`
  - `event:` deve corresponder ao campo JSON `type`
  - o evento terminal deve ser o literal `[DONE]`
- Itens de raciocínio podem expor `content`, `encrypted_content` e `summary`.
- Exemplos da HF incluem `OpenResponses-Version: latest` em requisições (header opcional).

## Arquitetura Proposta

- Adicionar `src/gateway/open-responses.schema.ts` contendo apenas schemas Zod (sem imports do gateway).
- Adicionar `src/gateway/openresponses-http.ts` (ou `open-responses-http.ts`) para `/v1/responses`.
- Manter `src/gateway/openai-http.ts` intacto como um adaptador de compatibilidade legado.
- Adicionar configuração `gateway.http.endpoints.responses.enabled` (padrão `false`).
- Manter `gateway.http.endpoints.chatCompletions.enabled` independente; permitir que ambos os endpoints sejam
  alternados separadamente.
- Emitir um aviso na inicialização quando Chat Completions estiver habilitado para sinalizar status legado.

## Caminho de Descontinuação para Chat Completions

- Manter limites rígidos entre módulos: nenhum tipo de schema compartilhado entre responses e chat completions.
- Tornar Chat Completions opt-in via configuração para que possa ser desativado sem mudanças de código.
- Atualizar a documentação para rotular Chat Completions como legado quando `/v1/responses` estiver estável.
- Etapa futura opcional: mapear requisições de Chat Completions para o handler de Responses para um
  caminho de remoção mais simples.

## Subconjunto de Suporte da Fase 1

- Aceitar `input` como string ou `ItemParam[]` com papéis de mensagem e `function_call_output`.
- Extrair mensagens de system e developer para `extraSystemPrompt`.
- Usar o `user` ou `function_call_output` mais recente como a mensagem atual para execuções de agentes.
- Rejeitar partes de conteúdo não suportadas (imagem/arquivo) com `invalid_request_error`.
- Retornar uma única mensagem do assistant com conteúdo `output_text`.
- Retornar `usage` com valores zerados até que a contabilização de tokens seja integrada.

## Estratégia de Validação (Sem SDK)

- Implementar schemas Zod para o subconjunto suportado de:
  - `CreateResponseBody`
  - `ItemParam` + uniões de partes de conteúdo de mensagem
  - `ResponseResource`
  - Formatos de eventos de streaming usados pelo gateway
- Manter os schemas em um único módulo isolado para evitar divergência e permitir futura geração de código.

## Implementação de Streaming (Fase 1)

- Linhas SSE com ambos `event:` e `data:`.
- Sequência obrigatória (mínimo viável):
  - `response.created`
  - `response.output_item.added`
  - `response.content_part.added`
  - `response.output_text.delta` (repetir conforme necessário)
  - `response.output_text.done`
  - `response.content_part.done`
  - `response.completed`
  - `[DONE]`

## Plano de Testes e Verificação

- Adicionar cobertura e2e para `/v1/responses`:
  - Autenticação obrigatória
  - Formato da resposta sem streaming
  - Ordenação de eventos de stream e `[DONE]`
  - Roteamento de sessão com headers e `user`
- Manter `src/gateway/openai-http.e2e.test.ts` inalterado.
- Manual: curl para `/v1/responses` com `stream: true` e verificar a ordenação dos eventos e o
  `[DONE]` terminal.

## Atualizações de Documentação (Follow-up)

- Adicionar uma nova página de docs para uso e exemplos de `/v1/responses`.
- Atualizar `/gateway/openai-http-api` com uma nota de legado e um apontamento para `/v1/responses`.
