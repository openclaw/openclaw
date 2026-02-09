---
summary: "Referência: regras de sanitização e reparo de transcrições específicas por provedor"
read_when:
  - Voce está depurando rejeições de requisições do provedor ligadas ao formato da transcrição
  - Voce está alterando a sanitização de transcrições ou a lógica de reparo de chamadas de ferramenta
  - Voce está investigando incompatibilidades de id de chamadas de ferramenta entre provedores
title: "Higiene da Transcrição"
---

# Higiene da Transcrição (Ajustes por Provedor)

Este documento descreve **correções específicas por provedor** aplicadas às transcrições antes de uma execução
(construção do contexto do modelo). Esses ajustes são **em memória** e usados para satisfazer requisitos
estritos dos provedores. Essas etapas de higiene **não** reescrevem a transcrição JSONL armazenada em disco;
no entanto, uma etapa separada de reparo de arquivo de sessão pode reescrever arquivos JSONL malformados
descartando linhas inválidas antes de a sessão ser carregada. Quando ocorre um reparo, o arquivo original é
salvo como backup ao lado do arquivo da sessão.

O escopo inclui:

- Sanitização de id de chamada de ferramenta
- Validação de entrada de chamada de ferramenta
- Reparo de pareamento de resultados de ferramenta
- Validação/ordenação de turnos
- Limpeza de assinatura de pensamento
- Sanitização de payloads de imagem

Se voce precisar de detalhes sobre armazenamento de transcrições, veja:

- [/reference/session-management-compaction](/reference/session-management-compaction)

---

## Onde isso é executado

Toda a higiene de transcrição é centralizada no runner incorporado:

- Seleção de política: `src/agents/transcript-policy.ts`
- Aplicação de sanitização/reparo: `sanitizeSessionHistory` em `src/agents/pi-embedded-runner/google.ts`

A política usa `provider`, `modelApi` e `modelId` para decidir o que aplicar.

Separadamente da higiene de transcrição, os arquivos de sessão são reparados (se necessário) antes do carregamento:

- `repairSessionFileIfNeeded` em `src/agents/session-file-repair.ts`
- Chamado a partir de `run/attempt.ts` e `compact.ts` (runner incorporado)

---

## Regra global: sanitização de imagens

Os payloads de imagem são sempre sanitizados para evitar rejeição do lado do provedor devido a limites
de tamanho (redução de escala/recompressão de imagens base64 superdimensionadas).

Implementação:

- `sanitizeSessionMessagesImages` em `src/agents/pi-embedded-helpers/images.ts`
- `sanitizeContentBlocksImages` em `src/agents/tool-images.ts`

---

## Regra global: chamadas de ferramenta malformadas

Blocos de chamada de ferramenta do assistente que não possuem tanto `input` quanto `arguments` são descartados
antes da construção do contexto do modelo. Isso evita rejeições do provedor decorrentes de chamadas de ferramenta
parcialmente persistidas (por exemplo, após uma falha por limite de taxa).

Implementação:

- `sanitizeToolCallInputs` em `src/agents/session-transcript-repair.ts`
- Aplicado em `sanitizeSessionHistory` em `src/agents/pi-embedded-runner/google.ts`

---

## Matriz de provedores (comportamento atual)

**OpenAI / OpenAI Codex**

- Apenas sanitização de imagens.
- Ao trocar o modelo para OpenAI Responses/Codex, descartar assinaturas de raciocínio órfãs (itens de raciocínio isolados sem um bloco de conteúdo subsequente).
- Nenhuma sanitização de id de chamada de ferramenta.
- Nenhum reparo de pareamento de resultados de ferramenta.
- Nenhuma validação ou reordenação de turnos.
- Nenhum resultado de ferramenta sintético.
- Nenhuma remoção de assinatura de pensamento.

**Google (Generative AI / Gemini CLI / Antigravity)**

- Sanitização de id de chamada de ferramenta: alfanumérico estrito.
- Reparo de pareamento de resultados de ferramenta e resultados de ferramenta sintéticos.
- Validação de turnos (alternância de turnos no estilo Gemini).
- Correção de ordenação de turnos do Google (antepor um pequeno bootstrap de usuário se o histórico começar com o assistente).
- Antigravity Claude: normalizar assinaturas de pensamento; descartar blocos de pensamento sem assinatura.

**Anthropic / Minimax (compatível com Anthropic)**

- Reparo de pareamento de resultados de ferramenta e resultados de ferramenta sintéticos.
- Validação de turnos (mesclar turnos consecutivos de usuário para satisfazer alternância estrita).

**Mistral (incluindo detecção baseada em id do modelo)**

- Sanitização de id de chamada de ferramenta: strict9 (alfanumérico com comprimento 9).

**OpenRouter Gemini**

- Limpeza de assinatura de pensamento: remover valores `thought_signature` que não sejam base64 (manter base64).

**Todos os demais**

- Apenas sanitização de imagens.

---

## Comportamento histórico (pré-2026.1.22)

Antes da versão 2026.1.22, o OpenClaw aplicava múltiplas camadas de higiene de transcrição:

- Uma **extensão de sanitização de transcrição** era executada em toda construção de contexto e podia:
  - Reparar o pareamento de uso/resultado de ferramentas.
  - Sanitizar ids de chamadas de ferramenta (incluindo um modo não estrito que preservava `_`/`-`).
- O runner também realizava sanitização específica por provedor, o que duplicava trabalho.
- Mutações adicionais ocorriam fora da política do provedor, incluindo:
  - Remoção de tags `<final>` do texto do assistente antes da persistência.
  - Descarte de turnos de erro vazios do assistente.
  - Corte do conteúdo do assistente após chamadas de ferramenta.

Essa complexidade causou regressões entre provedores (notavelmente no pareamento `openai-responses`
`call_id|fc_id`). A limpeza de 2026.1.22 removeu a extensão, centralizou a lógica no runner
e tornou o OpenAI **no-touch** além da sanitização de imagens.
