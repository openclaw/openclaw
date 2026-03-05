# Iris Dashboard — Plano de Melhorias

> **Data:** 28/02/2026
> **Status:** Proposta (revisao com Lucas na segunda)
> **Autor:** Iris

---

## 0. Estado Atual

O dashboard MVP esta funcional com:

- CRUD completo de tarefas (criar, editar, concluir, deletar, restaurar)
- Filtros por status, categoria, pessoa, busca textual, ordenacao
- Login com senha (localStorage + header X-Iris-Dashboard-Key)
- Realtime via WebSocket Supabase + fallback polling 5s
- HEARTBEAT.md auto-gerado no boot
- Webhook para conclusao de tarefas
- Light/dark theme toggle
- Responsivo (mobile)
- Soft delete com opcao de restaurar
- Paginacao

**Stack:** Vanilla JS (sem framework), CSS custom properties, Supabase REST.
**Tamanho:** ~24KB app.js, ~13KB styles.css, ~3.4KB api.js, ~3.7KB index.html

---

## 1. Melhorias Priorizadas

### P1 — Criticas (fazer primeiro)

#### 1.1 Notificacoes em Tempo Real (plano ja existe)

**Arquivo:** `docs/plan/iris-dashboard-notifications-plan.md`
**O que faz:** Quando Lucas cria/edita/conclui tarefa no dashboard, Iris e notificada automaticamente via `enqueueSystemEvent()` e pode confirmar via WhatsApp.
**Impacto:** Hoje Lucas precisa avisar a Iris manualmente. Com isso, qualquer mudanca no dashboard reflete instantaneamente na Iris.
**Estimativa:** ~4h de coding agent
**Dependencias:** Nenhuma

#### 1.2 Corrigir README (docs desatualizados)

**O que faz:** README diz que GET endpoints nao precisam de auth, mas o codigo exige auth em TODOS. Corrigir tabela de endpoints.
**Impacto:** Documentacao precisa > confusao futura.
**Estimativa:** 5 min (manual)

#### 1.3 HEARTBEAT.md auto-regeneracao

**O que faz:** Alem de gerar no boot, regenerar HEARTBEAT.md a cada mudanca de tarefa (criar/editar/concluir/deletar). Ja previsto no plano de notificacoes.
**Impacto:** HEARTBEAT.md sempre atualizado sem depender de restart.
**Estimativa:** Incluido na 1.1

---

### P2 — Importantes (semana que vem)

#### 2.1 Notas/Comentarios por Tarefa

**O que faz:** Campo de notas/historico em cada tarefa. Cada nota com timestamp e autor (iris/lucas).
**Schema:** Nova tabela `task_notes` ou array JSONB em `metadata`.
**UI:** Secao expansivel no card da tarefa ou dentro do modal de edicao.
**Impacto:** Rastreabilidade. Hoje descricao e estatica; notas permitem historico de evolucao.
**Estimativa:** ~3h

#### 2.2 Drag and Drop para mudar status

**O que faz:** Visao Kanban com colunas (Pendente | Em Andamento | Concluido | Cancelado). Arrastar card entre colunas muda status.
**UI:** Toggle entre visao "Grid" (atual) e "Kanban".
**Impacto:** UX muito mais intuitiva pra gestao visual.
**Estimativa:** ~4h

#### 2.3 Indicadores/Metricas no Header

**O que faz:** Contadores visuais no topo: total pendentes, em andamento, concluidas hoje, vencidas.
**UI:** 4 mini-cards tipo KPI acima dos filtros.
**Impacto:** Visao rapida do estado geral sem precisar filtrar.
**Estimativa:** ~2h

#### 2.4 Confirmacao antes de Deletar

**O que faz:** Modal de confirmacao ao clicar "Deletar" (hoje deleta direto).
**UI:** Modal simples "Tem certeza? [Cancelar] [Deletar]"
**Impacto:** Previne delecoes acidentais.
**Estimativa:** 30 min

#### 2.5 Modal de Conclusao

**O que faz:** Ao concluir tarefa, abrir modal pedindo "Concluido por" (lucas/iris/sistema) e nota opcional de conclusao.
**UI:** Modal simples com select + textarea.
**Impacto:** Melhor rastreabilidade de quem fez o que.
**Estimativa:** ~1h

---

### P3 — Nice to Have (backlog)

#### 3.1 Supabase Auth (plano em andamento)

**O que faz:** Substituir senha simples por Supabase Auth (email/senha com sessoes, refresh tokens).
**Status:** Subagente criando plano detalhado.
**Impacto:** Seguranca enterprise-grade. Multi-usuario no futuro.
**Estimativa:** ~6h

#### 3.2 Sub-tarefas / Checklist

**O que faz:** Cada tarefa pode ter sub-itens (checklist) com toggle de concluido.
**Schema:** Array JSONB em `metadata.checklist` ou tabela `task_items`.
**UI:** Lista de checkboxes dentro do card.
**Impacto:** Tarefas complexas ficam gerenciaveis.
**Estimativa:** ~3h

#### 3.3 Exportar para Markdown

**O que faz:** Botao "Exportar" que gera arquivo .md com todas as tarefas filtradas.
**UI:** Botao no header ou filtros.
**Impacto:** Backup manual / compartilhamento.
**Estimativa:** ~1h

#### 3.4 Tags/Labels

**O que faz:** Tags customizaveis por tarefa (ex: "urban", "qualiapps", "pessoal").
**Schema:** Array `text[]` ou tabela `task_tags`.
**UI:** Badges coloridas no card + filtro por tag.
**Impacto:** Organizacao transversal entre categorias.
**Estimativa:** ~3h

#### 3.5 Recorrencia

**O que faz:** Tarefas recorrentes (diaria, semanal, mensal). Ao concluir, cria nova instancia.
**Schema:** Campos `recorrencia_tipo`, `recorrencia_intervalo` na tabela.
**Impacto:** Crons visuais (ex: "cobrar Vanessa toda segunda").
**Estimativa:** ~4h

#### 3.6 Timeline / Activity Log

**O que faz:** Log de todas as mudancas por tarefa (criou, editou campo X, concluiu, etc).
**Schema:** Tabela `task_activity` com campos event_type, old_value, new_value, actor, timestamp.
**UI:** Timeline vertical dentro do modal de detalhe.
**Impacto:** Auditoria completa.
**Estimativa:** ~5h

#### 3.7 Integracao com Follow-ups

**O que faz:** Vincular tarefa a um follow-up automatico. Quando tarefa vence, Iris envia mensagem cobrando a pessoa.
**Impacto:** Automacao de cobrancas (Vanessa, Emival, etc).
**Estimativa:** ~4h
**Dependencias:** 1.1 (notificacoes) precisa estar pronta.

#### 3.8 Dark Mode Auto

**O que faz:** Respeitar `prefers-color-scheme` do sistema alem do toggle manual.
**Estimativa:** 15 min

---

## 2. Melhorias de Codigo/Infra

#### 2.A Remover polling quando WebSocket conecta

**Problema:** Hoje polling roda SEMPRE (mesmo com WS ativo). `startPolling()` e chamado no DOMContentLoaded incondicionalmente.
**Fix:** So iniciar polling como fallback; parar quando WS conecta (ja tem `stopPolling()` no onopen, mas `startPolling()` e chamado depois).
**Impacto:** Menos requests desnecessarios ao Supabase.

#### 2.B Health endpoint

**Problema:** README menciona `/iris-dashboard/health` mas nao existe implementado.
**Fix:** Adicionar endpoint que retorna status da conexao Supabase.

#### 2.C Refatorar app.js

**Problema:** 24KB num unico arquivo vanilla JS. Funcional mas dificil de manter.
**Opcoes:**

- Manter vanilla mas dividir em modulos ES (state.js, render.js, modal.js, filters.js)
- Migrar pra Preact/Lit (leve, ~4KB) se complexidade crescer
  **Recomendacao:** Dividir em modulos por enquanto. So migrar framework se P2 inteiro for implementado.

#### 2.D Testes E2E

**O que faz:** Playwright tests para o fluxo completo (login, criar, editar, concluir, filtrar).
**Impacto:** Confianca em deploys.
**Estimativa:** ~3h

---

## 3. Bugs Conhecidos

| #   | Bug                                                                    | Severidade |
| --- | ---------------------------------------------------------------------- | ---------- |
| 1   | Polling continua rodando com WS ativo (duplica requests)               | Baixa      |
| 2   | README desatualizado (auth em GET)                                     | Baixa      |
| 3   | Health endpoint nao existe                                             | Baixa      |
| 4   | `stagger-` animation delay so vai ate 6, cards apos o 6o nao tem delay | Cosmetico  |

---

## 4. Ordem de Execucao Sugerida

### Sprint 1 (segunda/terca)

1. **1.2** Corrigir README (5 min, manual)
2. **2.4** Confirmacao antes de deletar (30 min)
3. **2.5** Modal de conclusao (1h)
4. **2.A** Fix polling duplicado (15 min)
5. **2.3** Indicadores/metricas no header (2h)

### Sprint 2 (terca/quarta)

6. **1.1** Notificacoes em tempo real (4h, coding agent)
7. **2.1** Notas/comentarios (3h, coding agent)

### Sprint 3 (quinta+)

8. **2.2** Drag and drop Kanban (4h, coding agent)
9. **3.8** Dark mode auto (15 min)
10. **2.C** Refatorar app.js em modulos (2h)

### Backlog (quando couber)

11. Tags/labels
12. Sub-tarefas
13. Recorrencia
14. Timeline/activity log
15. Integracao follow-ups
16. Supabase Auth
17. Exportar markdown
18. Testes E2E

---

## 5. Notas

- Todo o codigo fica em `extensions/iris-dashboard/` (extension-first, sem tocar core)
- Cada sprint pode ser delegada a um coding agent com branch propria
- Notificacoes (1.1) e o item de maior impacto: transforma o dashboard de "painel passivo" em "centro de comando ativo"
- Kanban (2.2) e o item de maior impacto visual
- Ambos juntos fazem o dashboard competir com Trello/Linear pra uso pessoal
