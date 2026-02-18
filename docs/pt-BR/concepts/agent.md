---
summary: "Runtime do agente (pi-mono incorporado), contrato do workspace e bootstrap da sessão"
read_when:
  - Modificando runtime do agente, bootstrap do workspace ou comportamento da sessão
title: "Runtime do Agente"
---

# Runtime do Agente 🤖

OpenClaw executa um único runtime de agente incorporado derivado de **pi-mono**.

## Workspace (obrigatório)

OpenClaw usa um único diretório de workspace do agente (`agents.defaults.workspace`) como o **único** diretório de trabalho (`cwd`) do agente para ferramentas e contexto.

Recomendado: use `openclaw setup` para criar `~/.openclaw/openclaw.json` se não existir e inicializar os arquivos do workspace.

Layout completo do workspace + guia de backup: [Workspace do agente](/pt-BR/concepts/agent-workspace)

Se `agents.defaults.sandbox` estiver habilitado, sessões não principais podem sobrescrever isso com workspaces por sessão sob `agents.defaults.sandbox.workspaceRoot` (veja [Configuração do Gateway](/gateway/configuration)).

## Arquivos de bootstrap (injetados)

Dentro de `agents.defaults.workspace`, OpenClaw espera estes arquivos editáveis pelo usuário:

- `AGENTS.md` — instruções operacionais + "memória"
- `SOUL.md` — persona, limites, tom
- `TOOLS.md` — notas de ferramentas mantidas pelo usuário (ex. `imsg`, `sag`, convenções)
- `BOOTSTRAP.md` — ritual de primeira execução (excluído após conclusão)
- `IDENTITY.md` — nome/vibe/emoji do agente
- `USER.md` — perfil do usuário + endereço preferido

Na primeira volta de uma nova sessão, OpenClaw injeta o conteúdo destes arquivos diretamente no contexto do agente.

Arquivos em branco são ignorados. Arquivos grandes são cortados e truncados com um marcador para manter prompts enxutos (leia o arquivo para ver o conteúdo completo).

Se um arquivo estiver faltando, OpenClaw injeta uma única linha de marcador "arquivo faltando" (e `openclaw setup` criará um template padrão seguro).

`BOOTSTRAP.md` é criado apenas para um **workspace totalmente novo** (nenhum outro arquivo de bootstrap presente). Se você o excluir após concluir o ritual, ele não deve ser recriado em reinicializações posteriores.

Para desabilitar completamente a criação de arquivo de bootstrap (para workspaces pré-alimentados), defina:

```json5
{ agent: { skipBootstrap: true } }
```

## Ferramentas integradas

As ferramentas principais (read/exec/edit/write e ferramentas de sistema relacionadas) estão sempre disponíveis, sujeitas à política de ferramentas. `apply_patch` é opcional e restrito por `tools.exec.applyPatch`. `TOOLS.md` **não** controla quais ferramentas existem; é orientação sobre como _você_ quer usá-las.

## Skills

OpenClaw carrega skills de três locais (workspace vence em caso de conflito de nome):

- Agrupadas (enviadas com a instalação)
- Gerenciadas/locais: `~/.openclaw/skills`
- Workspace: `<workspace>/skills`

Skills podem ser restringidas por config/env (veja `skills` em [Configuração do Gateway](/gateway/configuration)).

## Integração pi-mono

OpenClaw reutiliza pedaços da base de código pi-mono (modelos/ferramentas), mas **gerenciamento de sessão, descoberta e configuração de ferramentas são propriedade do OpenClaw**.

- Sem runtime do agente de codificação pi.
- Configurações `~/.pi/agent` ou `<workspace>/.pi` não são consultadas.

## Sessões

Transcrições de sessão são armazenadas como JSONL em:

- `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl`

O ID da sessão é estável e escolhido pelo OpenClaw.
Pastas de sessão legadas Pi/Tau **não** são lidas.

## Direcionamento durante streaming

Quando o modo de fila é `steer`, mensagens de entrada são injetadas na execução atual.
A fila é verificada **após cada chamada de ferramenta**; se uma mensagem em fila estiver presente, as chamadas de ferramenta restantes da mensagem de assistente atual são ignoradas (resultados de ferramenta de erro com "Skipped due to queued user message."), então a mensagem de usuário em fila é injetada antes da próxima resposta do assistente.

Quando o modo de fila é `followup` ou `collect`, mensagens de entrada são mantidas até o encerramento da volta atual, então uma nova volta de agente começa com as cargas em fila. Veja [Fila](/pt-BR/concepts/queue) para comportamento de modo + debounce/cap.

O streaming de bloco envia blocos de assistente completados assim que terminam; está **desabilitado por padrão** (`agents.defaults.blockStreamingDefault: "off"`).
Ajuste o limite via `agents.defaults.blockStreamingBreak` (`text_end` vs `message_end`; padrão é text_end).
Controle o chunking de bloco suave com `agents.defaults.blockStreamingChunk` (padrão de 800–1200 chars; prefere quebras de parágrafo, depois quebras de linha; sentenças por último).
Coalesce chunks transmitidos com `agents.defaults.blockStreamingCoalesce` para reduzir spam de linha única (fusão baseada em ocioso antes do envio). Canais não-Telegram requerem `*.blockStreaming: true` explícito para habilitar respostas de bloco.
Resumos de ferramenta detalhados são emitidos no início da ferramenta (sem debounce); Interface de Controle faz stream de saída de ferramenta via eventos do agente quando disponível.
Mais detalhes: [Streaming + chunking](/pt-BR/concepts/streaming).

## Referências de modelo

Referências de modelo em config (por exemplo `agents.defaults.model` e `agents.defaults.models`) são analisadas dividindo no **primeiro** `/`.

- Use `provider/model` ao configurar modelos.
- Se o ID do modelo em si contiver `/` (estilo OpenRouter), inclua o prefixo do provedor (exemplo: `openrouter/moonshotai/kimi-k2`).
- Se você omitir o provedor, OpenClaw trata a entrada como um alias ou um modelo para o **provedor padrão** (funciona apenas quando não há `/` no ID do modelo).

## Configuração (mínima)

No mínimo, defina:

- `agents.defaults.workspace`
- `channels.whatsapp.allowFrom` (altamente recomendado)

---

_Próximo: [Chats em Grupo](/channels/group-messages)_ 🦞
