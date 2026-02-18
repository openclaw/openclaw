---
summary: "Ciclo de vida do loop do agente, streams e semântica de espera"
read_when:
  - Você precisa de um walkthrough exato do loop do agente ou eventos de ciclo de vida
title: "Loop do Agente"
---

# Loop do Agente (OpenClaw)

Um loop agentic é a execução "real" completa de um agente: intake → montagem de contexto → inferência de modelo → execução de ferramentas → respostas em stream → persistência. É o caminho autoritário que transforma uma mensagem em ações e uma resposta final, mantendo o estado da sessão consistente.

Em OpenClaw, um loop é uma execução única e serializada por sessão que emite eventos de ciclo de vida e stream enquanto o modelo pensa, chama ferramentas e faz stream de saída. Este documento explica como esse loop autêntico é conectado ponta a ponta.

## Pontos de entrada

- Gateway RPC: `agent` e `agent.wait`.
- CLI: comando `agent`.

## Como funciona (alto nível)

1. `agent` RPC valida parâmetros, resolve sessão (sessionKey/sessionId), persiste metadados de sessão, retorna `{ runId, acceptedAt }` imediatamente.
2. `agentCommand` executa o agente:
   - resolve model + padrões thinking/verbose
   - carrega snapshot de skills
   - chama `runEmbeddedPiAgent` (runtime pi-agent-core)
   - emite **lifecycle end/error** se o loop incorporado não emitir um
3. `runEmbeddedPiAgent`:
   - serializa execuções via filas por sessão + globais
   - resolve model + perfil de autenticação e constrói a sessão pi
   - se inscreve em eventos pi e faz stream de deltas de assistente/ferramenta
   - força timeout -> aborta execução se excedido
   - retorna payloads + metadados de uso
4. `subscribeEmbeddedPiSession` faz a ponte entre eventos pi-agent-core e stream `agent` do OpenClaw:
   - eventos de ferramenta => `stream: "tool"`
   - deltas de assistente => `stream: "assistant"`
   - eventos de ciclo de vida => `stream: "lifecycle"` (`phase: "start" | "end" | "error"`)
5. `agent.wait` usa `waitForAgentJob`:
   - aguarda **lifecycle end/error** para `runId`
   - retorna `{ status: ok|error|timeout, startedAt, endedAt, error? }`

## Fila + concorrência

- Execuções são serializadas por chave de sessão (pista de sessão) e opcionalmente através de uma pista global.
- Isso previne corridas de ferramenta/sessão e mantém histórico de sessão consistente.
- Canais de mensagens podem escolher modos de fila (collect/steer/followup) que alimentam este sistema de pista.
  Veja [Fila de Comando](/concepts/queue).

## Preparação de sessão + workspace

- Workspace é resolvido e criado; execuções em sandbox podem redirecionar para uma raiz de workspace sandbox.
- Skills são carregadas (ou reutilizadas de um snapshot) e injetadas em env e prompt.
- Arquivos de bootstrap/contexto são resolvidos e injetados no relatório de prompt do sistema.
- Um lock de escrita de sessão é adquirido; `SessionManager` é aberto e preparado antes do streaming.

## Montagem de prompt + prompt do sistema

- Prompt do sistema é construído a partir do prompt base do OpenClaw, prompt de skills, contexto de bootstrap e substituições por execução.
- Limites específicos de modelo e tokens de reserva de compactação são aplicados.
- Veja [System prompt](/pt-BR/concepts/system-prompt) para o que o modelo vê.

## Pontos de gancho (onde você pode interceptar)

OpenClaw tem dois sistemas de gancho:

- **Ganchos internos** (Ganchos gateway): scripts orientados por eventos para comandos e eventos de ciclo de vida.
- **Ganchos de plugin**: pontos de extensão dentro do ciclo de vida de agente/ferramenta e pipeline do gateway.

### Ganchos internos (Ganchos gateway)

- **`agent:bootstrap`**: executa durante a construção de arquivos de bootstrap antes do prompt do sistema ser finalizado.
  Use isso para adicionar/remover arquivos de contexto de bootstrap.
- **Ganchos de comando**: `/new`, `/reset`, `/stop` e outros eventos de comando (veja documentação de Ganchos).

Veja [Ganchos](/automation/hooks) para setup e exemplos.

### Ganchos de plugin (ciclo de vida de agente + gateway)

Estes executam dentro do loop do agente ou pipeline do gateway:

- **`before_agent_start`**: injeta contexto ou sobrescreve prompt do sistema antes da execução iniciar.
- **`agent_end`**: inspeciona a lista final de mensagens e metadados de execução após conclusão.
- **`before_compaction` / `after_compaction`**: observe ou anote ciclos de compactação.
- **`before_tool_call` / `after_tool_call`**: intercepta parâmetros/resultados de ferramenta.
- **`tool_result_persist`**: transforma sincronamente resultados de ferramenta antes de serem escritos na transcrição de sessão.
- **`message_received` / `message_sending` / `message_sent`**: ganchos de mensagem de entrada + saída.
- **`session_start` / `session_end`**: limites de ciclo de vida de sessão.
- **`gateway_start` / `gateway_stop`**: eventos de ciclo de vida do gateway.

Veja [Plugins](/tools/plugin#plugin-hooks) para detalhes da API de gancho e registro.

## Streaming + respostas parciais

- Deltas de assistente são feitas em stream a partir de pi-agent-core e emitidas como eventos `assistant`.
- Block streaming pode emitir respostas parciais em `text_end` ou `message_end`.
- Streaming de raciocínio pode ser emitido como um stream separado ou como respostas de bloco.
- Veja [Streaming](/pt-BR/concepts/streaming) para comportamento de chunking e resposta de bloco.
