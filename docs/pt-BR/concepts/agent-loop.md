---
summary: "Ciclo de vida do agent loop, streams e semântica de espera"
read_when:
  - Você precisa de um passo a passo exato do agent loop ou dos eventos do ciclo de vida
title: "Agent Loop"
---

# Agent Loop (OpenClaw)

Um loop agêntico é a execução “real” completa de um agente: ingestão → montagem de contexto → inferência do modelo →
execução de ferramentas → respostas em streaming → persistência. É o caminho autoritativo que transforma uma mensagem
em ações e uma resposta final, mantendo o estado da sessão consistente.

No OpenClaw, um loop é uma única execução serializada por sessão que emite eventos de ciclo de vida e de stream
conforme o modelo pensa, chama ferramentas e transmite a saída. Este documento explica como esse loop autêntico
é conectado de ponta a ponta.

## Pontos de entrada

- RPC do Gateway: `agent` e `agent.wait`.
- CLI: comando `agent`.

## Como funciona (alto nível)

1. O RPC `agent` valida parâmetros, resolve a sessão (sessionKey/sessionId), persiste metadados da sessão e retorna `{ runId, acceptedAt }` imediatamente.
2. O `agentCommand` executa o agente:
   - resolve o modelo + padrões de thinking/verbose
   - carrega o snapshot de Skills
   - chama `runEmbeddedPiAgent` (runtime do pi-agent-core)
   - emite **lifecycle end/error** se o loop incorporado não emitir um
3. O `runEmbeddedPiAgent`:
   - serializa execuções via filas por sessão + globais
   - resolve o modelo + perfil de autenticação e constrói a sessão do pi
   - assina eventos do pi e transmite deltas do assistente/ferramentas
   - impõe timeout -> aborta a execução se excedido
   - retorna payloads + metadados de uso
4. O `subscribeEmbeddedPiSession` faz a ponte dos eventos do pi-agent-core para o stream `agent` do OpenClaw:
   - eventos de ferramenta => `stream: "tool"`
   - deltas do assistente => `stream: "assistant"`
   - eventos de ciclo de vida => `stream: "lifecycle"` (`phase: "start" | "end" | "error"`)
5. O `agent.wait` usa `waitForAgentJob`:
   - aguarda **lifecycle end/error** para `runId`
   - retorna `{ status: ok|error|timeout, startedAt, endedAt, error? }`

## Enfileiramento + concorrência

- As execuções são serializadas por chave de sessão (faixa de sessão) e opcionalmente por uma faixa global.
- Isso evita corridas de ferramenta/sessão e mantém o histórico da sessão consistente.
- Canais de mensagens podem escolher modos de fila (collect/steer/followup) que alimentam esse sistema de faixas.
  Veja [Command Queue](/concepts/queue).

## Preparação de sessão + workspace

- O workspace é resolvido e criado; execuções em sandbox podem redirecionar para uma raiz de workspace em sandbox.
- Skills são carregadas (ou reutilizadas a partir de um snapshot) e injetadas no env e no prompt.
- Arquivos de bootstrap/contexto são resolvidos e injetados no relatório do prompt do sistema.
- Um bloqueio de escrita da sessão é adquirido; `SessionManager` é aberto e preparado antes do streaming.

## Montagem do prompt + prompt do sistema

- O prompt do sistema é construído a partir do prompt base do OpenClaw, prompt de Skills, contexto de bootstrap e substituições por execução.
- Limites específicos do modelo e tokens de reserva para compactação são aplicados.
- Veja [System prompt](/concepts/system-prompt) para o que o modelo vê.

## Pontos de hook (onde você pode interceptar)

O OpenClaw possui dois sistemas de hooks:

- **Hooks internos** (hooks do Gateway): scripts orientados a eventos para comandos e eventos de ciclo de vida.
- **Hooks de plugin**: pontos de extensão dentro do ciclo de vida do agente/ferramenta e do pipeline do gateway.

### Hooks internos (hooks do Gateway)

- **`agent:bootstrap`**: executa durante a construção dos arquivos de bootstrap antes do prompt do sistema ser finalizado.
  Use isso para adicionar/remover arquivos de contexto de bootstrap.
- **Hooks de comando**: `/new`, `/reset`, `/stop` e outros eventos de comando (veja o doc de Hooks).

Veja [Hooks](/automation/hooks) para configuração e exemplos.

### Hooks de plugin (ciclo de vida do agente + gateway)

Eles executam dentro do agent loop ou do pipeline do gateway:

- **`before_agent_start`**: injeta contexto ou sobrescreve o prompt do sistema antes do início da execução.
- **`agent_end`**: inspeciona a lista final de mensagens e metadados da execução após a conclusão.
- **`before_compaction` / `after_compaction`**: observa ou anota ciclos de compactação.
- **`before_tool_call` / `after_tool_call`**: intercepta parâmetros/resultados de ferramentas.
- **`tool_result_persist`**: transforma sincronicamente resultados de ferramentas antes de serem gravados no transcript da sessão.
- **`message_received` / `message_sending` / `message_sent`**: hooks de mensagens de entrada + saída.
- **`session_start` / `session_end`**: limites do ciclo de vida da sessão.
- **`gateway_start` / `gateway_stop`**: eventos do ciclo de vida do gateway.

Veja [Plugins](/tools/plugin#plugin-hooks) para a API de hooks e detalhes de registro.

## Streaming + respostas parciais

- Deltas do assistente são transmitidos a partir do pi-agent-core e emitidos como eventos `assistant`.
- O streaming em blocos pode emitir respostas parciais em `text_end` ou `message_end`.
- O streaming de raciocínio pode ser emitido como um stream separado ou como respostas em bloco.
- Veja [Streaming](/concepts/streaming) para comportamento de fragmentação e respostas em bloco.

## Execução de ferramentas + ferramentas de mensagens

- Eventos de início/atualização/fim de ferramentas são emitidos no stream `tool`.
- Resultados de ferramentas são sanitizados quanto a tamanho e payloads de imagem antes de registrar/emitir.
- Envios por ferramentas de mensagens são rastreados para suprimir confirmações duplicadas do assistente.

## Modelagem de resposta + supressão

- Payloads finais são montados a partir de:
  - texto do assistente (e raciocínio opcional)
  - resumos inline de ferramentas (quando verbose + permitido)
  - texto de erro do assistente quando o modelo falha
- `NO_REPLY` é tratado como um token silencioso e filtrado dos payloads de saída.
- Duplicatas de ferramentas de mensagens são removidas da lista final de payloads.
- Se nenhum payload renderizável permanecer e uma ferramenta falhar, uma resposta de erro de ferramenta de fallback é emitida
  (a menos que uma ferramenta de mensagens já tenha enviado uma resposta visível ao usuário).

## Compactação + tentativas

- A compactação automática emite eventos de stream `compaction` e pode disparar uma nova tentativa.
- Na nova tentativa, buffers em memória e resumos de ferramentas são redefinidos para evitar saída duplicada.
- Veja [Compaction](/concepts/compaction) para o pipeline de compactação.

## Streams de eventos (hoje)

- `lifecycle`: emitido por `subscribeEmbeddedPiSession` (e como fallback por `agentCommand`)
- `assistant`: deltas transmitidos do pi-agent-core
- `tool`: eventos de ferramentas transmitidos do pi-agent-core

## Tratamento de canais de chat

- Deltas do assistente são armazenados em mensagens de chat `delta`.
- Uma mensagem de chat `final` é emitida em **lifecycle end/error**.

## Timeouts

- Padrão de `agent.wait`: 30s (apenas a espera). O parâmetro `timeoutMs` substitui.
- Runtime do agente: padrão de `agents.defaults.timeoutSeconds` 600s; imposto no temporizador de aborto `runEmbeddedPiAgent`.

## Onde as coisas podem terminar cedo

- Timeout do agente (aborto)
- AbortSignal (cancelamento)
- Desconexão do Gateway ou timeout de RPC
- Timeout de `agent.wait` (apenas espera, não interrompe o agente)
