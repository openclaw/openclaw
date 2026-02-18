---
title: "Memória"
summary: "Como a memória do OpenClaw funciona (arquivos de workspace + flush automático de memória)"
read_when:
  - Você quer o layout e fluxo de arquivo de memória
  - Você quer ajustar o flush automático de memória pré-compactação
---

# Memória

A memória do OpenClaw é **Markdown simples no workspace do agente**. Os arquivos são a fonte de verdade; o modelo apenas "lembra" do que é escrito em disco.

Ferramentas de busca de memória são fornecidas pelo plugin de memória ativo (padrão: `memory-core`). Desabilite plugins de memória com `plugins.slots.memory = "none"`.

## Arquivos de memória (Markdown)

O layout de workspace padrão usa duas camadas de memória:

- `memory/YYYY-MM-DD.md`
  - Log diário (append-only).
  - Leia hoje + ontem no início da sessão.
- `MEMORY.md` (opcional)
  - Memória de longo prazo curada.
  - **Só carregue na sessão principal privada** (nunca em contextos de grupo).

Esses arquivos vivem sob o workspace (`agents.defaults.workspace`, padrão `~/.openclaw/workspace`). Veja [Workspace do agente](/pt-BR/concepts/agent-workspace) para o layout completo.

## Quando escrever memória

- Decisões, preferências e fatos duráveis vão para `MEMORY.md`.
- Notas do dia a dia e contexto em execução vão para `memory/YYYY-MM-DD.md`.
- Se alguém disser "lembre-se disso," escreva (não mantenha em RAM).
- Esta área ainda está evoluindo. Ajuda a lembrar o modelo de armazenar memórias; ele saberá o que fazer.
- Se você quer que algo persista, **peça ao bot para escrever** na memória.

## Flush automático de memória (ping pré-compactação)

Quando uma sessão está **perto de auto-compactação**, OpenClaw ativa uma volta **silenciosa e agentic** que lembra o modelo de escrever memória durável **antes** do contexto ser compactado. Os prompts padrão dizem explicitamente que o modelo _pode responder_, mas geralmente `NO_REPLY` é a resposta correta para que o usuário nunca veja essa volta.

Isso é controlado por `agents.defaults.compaction.memoryFlush`:

```json5
{
  agents: {
    defaults: {
      compaction: {
        reserveTokensFloor: 20000,
        memoryFlush: {
          enabled: true,
          softThresholdTokens: 4000,
          systemPrompt: "Session nearing compaction. Store durable memories now.",
          prompt: "Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store.",
        },
      },
    },
  },
}
```

Detalhes:

- **Soft threshold**: flush ativa quando a estimativa de token de sessão cruza `contextWindow - reserveTokensFloor - softThresholdTokens`.
- **Silencioso** por padrão: prompts incluem `NO_REPLY` para que nada seja entregue.
- **Dois prompts**: um prompt de usuário plus um append de prompt do sistema o lembrete.
- **Um flush por ciclo de compactação** (rastreado em `sessions.json`).
- **Workspace deve ser gravável**: se a sessão executar sandboxed com `workspaceAccess: "ro"` ou `"none"`, o flush é ignorado.

Para o ciclo de vida de compactação completo, veja [Gerenciamento de sessão + compactação](/reference/session-management-compaction).

## Busca de memória vetorial

OpenClaw pode construir um pequeno índice vetorial sobre `MEMORY.md` e `memory/*.md` para que consultas semânticas possam encontrar notas relacionadas mesmo quando a redação difere.

Padrões:

- Habilitado por padrão.
- Observa arquivos de memória para mudanças (debounced).
- Configure busca de memória sob `agents.defaults.memorySearch` (não `memorySearch` no nível superior).
- Usa embeddings remotos por padrão. Se `memorySearch.provider` não estiver definido, OpenClaw auto-seleciona:
  1. `local` se um `memorySearch.local.modelPath` estiver configurado e o arquivo existir.
  2. `openai` se uma chave OpenAI puder ser resolvida.
  3. `gemini` se uma chave Gemini puder ser resolvida.
  4. `voyage` se uma chave Voyage puder ser resolvida.
  5. Caso contrário, busca de memória permanece desabilitada até ser configurada.
- Modo local usa node-llama-cpp e pode exigir `pnpm approve-builds`.
- Usa sqlite-vec (quando disponível) para acelerar busca vetorial dentro de SQLite.

Embeddings remotos **requerem** uma chave de API para o provedor de embedding. OpenClaw resolve chaves de perfis de autenticação, `models.providers.*.apiKey` ou variáveis de ambiente.
