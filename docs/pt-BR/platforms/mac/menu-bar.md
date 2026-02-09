---
summary: "Lógica de status da barra de menu e o que é exibido aos usuários"
read_when:
  - Ajustando a UI do menu do mac ou a lógica de status
title: "Barra de Menu"
---

# Lógica de Status da Barra de Menu

## O que é exibido

- Exibimos o estado atual de trabalho do agente no ícone da barra de menu e na primeira linha de status do menu.
- O status de saúde fica oculto enquanto há trabalho ativo; ele retorna quando todas as sessões estão ociosas.
- O bloco “Nodes” no menu lista apenas **dispositivos** (nós pareados via `node.list`), não entradas de cliente/presença.
- Uma seção “Usage” aparece sob Context quando há snapshots de uso do provedor disponíveis.

## Modelo de estados

- Sessões: os eventos chegam com `runId` (por execução) mais `sessionKey` no payload. A sessão “principal” é a chave `main`; se ausente, usamos como fallback a sessão atualizada mais recentemente.
- Prioridade: a principal sempre vence. Se a principal estiver ativa, seu estado é mostrado imediatamente. Se a principal estiver ociosa, a sessão não‑principal ativa mais recente é exibida. Não alternamos no meio da atividade; só trocamos quando a sessão atual fica ociosa ou quando a principal se torna ativa.
- Tipos de atividade:
  - `job`: execução de comando de alto nível (`state: started|streaming|done|error`).
  - `tool`: `phase: start|result` com `toolName` e `meta/args`.

## Enum IconState (Swift)

- `idle`
- `workingMain(ActivityKind)`
- `workingOther(ActivityKind)`
- `overridden(ActivityKind)` (substituição de debug)

### ActivityKind → glifo

- `exec` → 💻
- `read` → 📄
- `write` → ✍️
- `edit` → 📝
- `attach` → 📎
- padrão → 🛠️

### Mapeamento visual

- `idle`: criaturinha normal.
- `workingMain`: badge com glifo, tinta completa, animação de “trabalho” das pernas.
- `workingOther`: badge com glifo, tinta atenuada, sem correria.
- `overridden`: usa o glifo/tinta escolhidos independentemente da atividade.

## Texto da linha de status (menu)

- Enquanto há trabalho ativo: `<Session role> · <activity label>`
  - Exemplos: `Main · exec: pnpm test`, `Other · read: apps/macos/Sources/OpenClaw/AppState.swift`.
- Quando ocioso: retorna ao resumo de saúde.

## Ingestão de eventos

- Fonte: eventos `agent` do canal de controle (`ControlChannel.handleAgentEvent`).
- Campos analisados:
  - `stream: "job"` com `data.state` para início/parada.
  - `stream: "tool"` com `data.phase`, `name`, opcional `meta`/`args`.
- Rótulos:
  - `exec`: primeira linha de `args.command`.
  - `read`/`write`: caminho encurtado.
  - `edit`: caminho mais tipo de alteração inferido de `meta`/contagens de diff.
  - fallback: nome da ferramenta.

## Substituição de debug

- Configurações ▸ Debug ▸ seletor “Icon override”:
  - `System (auto)` (padrão)
  - `Working: main` (por tipo de ferramenta)
  - `Working: other` (por tipo de ferramenta)
  - `Idle`
- Armazenado via `@AppStorage("iconOverride")`; mapeado para `IconState.overridden`.

## Checklist de testes

- Acionar job da sessão principal: verificar que o ícone alterna imediatamente e a linha de status mostra o rótulo da principal.
- Acionar job de sessão não‑principal enquanto a principal está ociosa: ícone/status mostram a não‑principal; permanecem estáveis até finalizar.
- Iniciar a principal enquanto outra está ativa: ícone muda para a principal instantaneamente.
- Rajadas rápidas de ferramentas: garantir que o badge não pisque (TTL de tolerância nos resultados de ferramentas).
- A linha de saúde reaparece quando todas as sessões ficam ociosas.
