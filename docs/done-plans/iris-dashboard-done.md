# Plano de Implementacao - Iris Dashboard (Final)

> Projeto: Dashboard Interativo de Tarefas
> Data: 27/02/2026
> Status: IMPLEMENTADO EM 27/02/2026
> Escopo: Implementacao completa em extensions/iris-dashboard/

## Resumo da Implementacao

- Branch: `feature/iris-dashboard`
- Commits atomicos: Fase A (scaffolding), B (migration.sql), C (API), D (UI), E (heartbeat), F (testes)
- 28 testes passando (service, routes-api, routes-webhook, heartbeat)
- pnpm build sem erros
- Nenhum arquivo do core (src/, ui/) alterado

### Checklist de Aceite

- [x] migration.sql idempotente com constraints, indices, trigger, RLS, realtime
- [x] Todas as rotas da Secao 5 implementadas com contratos corretos
- [x] Soft delete e restore funcionando
- [x] Webhook processa apenas transicao real para `concluido`
- [x] HEARTBEAT.md gerado no boot via gateway_start hook
- [x] UI responsiva com design tokens de ui/src/styles/base.css
- [x] Nenhum arquivo core alterado
- [x] 28 testes passando

---

## 0. Objetivo e Criterio de Pronto

Objetivo: entregar um dashboard de tarefas para Iris/Lucas com CRUD, realtime, webhook e fallback HEARTBEAT, mantendo independencia do core para reduzir conflito com merges futuros do upstream.

Este plano esta completo quando um novo agente consegue:

1. Criar a extensao `extensions/iris-dashboard/` sem tocar `src/` ou `ui/` do core no MVP.
2. Aplicar a migration SQL em Supabase e validar tabela/indices/RLS/realtime.
3. Implementar todas as rotas da API exatamente como especificadas.
4. Implementar a UI standalone com o design system definido.
5. Entregar testes minimos e checklist de validacao final.

---

## 1. Guardrails de Merge (Obrigatorios)

1. Abordagem extension-first: toda logica do MVP deve ficar em `extensions/iris-dashboard/`.
2. Nao alterar arquivos do core (`src/**`, `ui/**`) no MVP.
3. Nao usar host/path absoluto no codigo nem no plano (usar placeholders e config).
4. Endpoints mutaveis devem ter autenticacao explicita.
5. Hook de inicializacao deve usar eventos existentes no plugin SDK (`gateway_start` ou `session_start`), nunca `session_init`.
6. Sem dependencias novas no root `package.json`; dependencias da feature devem ficar no `package.json` da extensao.

---

## 2. Arquitetura Final do MVP

1. UI standalone servida pela extensao em `/iris-dashboard`.
2. API HTTP da extensao em `/iris-dashboard/api/*`.
3. Persistencia em Supabase (`public.tasks`).
4. Webhook Supabase para `/iris-dashboard/webhook/tasks`.
5. Fallback com geracao de `memory/HEARTBEAT.md` via hook da extensao.

Fluxo principal:

1. Iris/Lucas criam/atualizam tarefa via API da extensao.
2. Extensao grava no Supabase usando service key.
3. UI atualiza por fetch + realtime.
4. Quando status muda para `concluido`, webhook aciona notificacao interna.
5. Hook de boot gera HEARTBEAT.md com pendencias ativas.

---

## 3. Schema SQL Final (migration.sql completo)

Arquivo alvo: `extensions/iris-dashboard/migration.sql`

```sql
-- Iris Dashboard - Supabase migration (idempotente)
-- Arquivo: extensions/iris-dashboard/migration.sql

begin;

create extension if not exists pgcrypto;

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  titulo text not null,
  descricao text,
  status text not null default 'pendente',
  categoria text not null default 'backlog',
  prioridade smallint not null default 3,
  pessoa text,
  origem text not null default 'iris',
  vencimento_em timestamptz,
  concluido_em timestamptz,
  concluido_por text,
  metadata jsonb not null default '{}'::jsonb,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  deleted_at timestamptz
);

-- Compatibilidade com ambientes onde a tabela ja exista com colunas faltantes
alter table public.tasks add column if not exists titulo text;
alter table public.tasks add column if not exists descricao text;
alter table public.tasks add column if not exists status text;
alter table public.tasks add column if not exists categoria text;
alter table public.tasks add column if not exists prioridade smallint;
alter table public.tasks add column if not exists pessoa text;
alter table public.tasks add column if not exists origem text;
alter table public.tasks add column if not exists vencimento_em timestamptz;
alter table public.tasks add column if not exists concluido_em timestamptz;
alter table public.tasks add column if not exists concluido_por text;
alter table public.tasks add column if not exists metadata jsonb;
alter table public.tasks add column if not exists criado_em timestamptz;
alter table public.tasks add column if not exists atualizado_em timestamptz;
alter table public.tasks add column if not exists deleted_at timestamptz;

-- Defaults/minimos esperados
alter table public.tasks alter column titulo set not null;
alter table public.tasks alter column status set default 'pendente';
alter table public.tasks alter column categoria set default 'backlog';
alter table public.tasks alter column prioridade set default 3;
alter table public.tasks alter column origem set default 'iris';
alter table public.tasks alter column metadata set default '{}'::jsonb;
alter table public.tasks alter column criado_em set default now();
alter table public.tasks alter column atualizado_em set default now();

-- Constraints idempotentes
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tasks_titulo_not_blank'
  ) THEN
    ALTER TABLE public.tasks
      ADD CONSTRAINT tasks_titulo_not_blank
      CHECK (length(btrim(titulo)) BETWEEN 1 AND 200);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tasks_status_check'
  ) THEN
    ALTER TABLE public.tasks
      ADD CONSTRAINT tasks_status_check
      CHECK (status IN ('pendente', 'em_andamento', 'concluido', 'cancelado'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tasks_categoria_check'
  ) THEN
    ALTER TABLE public.tasks
      ADD CONSTRAINT tasks_categoria_check
      CHECK (categoria IN ('follow_up', 'backlog', 'urgente', 'proximo', 'outros'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tasks_prioridade_range'
  ) THEN
    ALTER TABLE public.tasks
      ADD CONSTRAINT tasks_prioridade_range
      CHECK (prioridade BETWEEN 1 AND 5);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tasks_origem_check'
  ) THEN
    ALTER TABLE public.tasks
      ADD CONSTRAINT tasks_origem_check
      CHECK (origem IN ('iris', 'lucas', 'sistema'));
  END IF;
END
$$;

-- Trigger para atualizado_em + consistencia de concluido_em/concluido_por
create or replace function public.tasks_touch() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    new.criado_em := coalesce(new.criado_em, now());
  end if;

  new.atualizado_em := now();

  if new.status = 'concluido' then
    new.concluido_em := coalesce(new.concluido_em, now());
  else
    new.concluido_em := null;
    new.concluido_por := null;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_tasks_touch on public.tasks;
create trigger trg_tasks_touch
before insert or update on public.tasks
for each row
execute function public.tasks_touch();

-- Indices para leitura do dashboard
create index if not exists idx_tasks_status_created
  on public.tasks (status, criado_em desc)
  where deleted_at is null;

create index if not exists idx_tasks_categoria_created
  on public.tasks (categoria, criado_em desc)
  where deleted_at is null;

create index if not exists idx_tasks_pessoa_created
  on public.tasks (pessoa, criado_em desc)
  where deleted_at is null and pessoa is not null;

create index if not exists idx_tasks_vencimento
  on public.tasks (vencimento_em)
  where deleted_at is null and vencimento_em is not null;

create index if not exists idx_tasks_atualizado_em
  on public.tasks (atualizado_em desc)
  where deleted_at is null;

create index if not exists idx_tasks_search
  on public.tasks
  using gin (to_tsvector('simple', coalesce(titulo, '') || ' ' || coalesce(descricao, '')))
  where deleted_at is null;

-- RLS
alter table public.tasks enable row level security;

drop policy if exists tasks_service_role_all on public.tasks;
create policy tasks_service_role_all
  on public.tasks
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists tasks_authenticated_rw on public.tasks;
create policy tasks_authenticated_rw
  on public.tasks
  for all
  to authenticated
  using (true)
  with check (true);

-- Realtime publication (idempotente)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'
  ) THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'tasks'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.tasks;
    END IF;
  END IF;
END
$$;

comment on table public.tasks is 'Tarefas operacionais do Iris Dashboard';
comment on column public.tasks.metadata is 'Dados livres (jsonb) para extensoes futuras';

commit;
```

### 3.1 Configuracao Supabase apos migration

1. Confirmar `public.tasks` em Database > Replication > Realtime.
2. Criar webhook de `UPDATE` em `public.tasks` com URL: `https://<gateway-host>:18789/iris-dashboard/webhook/tasks`.
3. Configurar segredo do webhook igual ao valor de `IRIS_DASHBOARD_WEBHOOK_SECRET`.

---

## 4. Estrutura Final de Arquivos da Extensao

```text
extensions/iris-dashboard/
├── index.ts
├── openclaw.plugin.json
├── package.json
├── README.md
├── migration.sql
├── src/
│   ├── config.ts
│   ├── types.ts
│   ├── validation.ts
│   ├── auth.ts
│   ├── supabase.ts
│   ├── tasks-repository.ts
│   ├── tasks-service.ts
│   ├── routes-ui.ts
│   ├── routes-api.ts
│   ├── routes-webhook.ts
│   ├── heartbeat.ts
│   └── system-events.ts
├── ui/
│   ├── index.html
│   ├── app.js
│   ├── api.js
│   └── styles.css
└── test/
    ├── routes-api.test.ts
    ├── routes-webhook.test.ts
    ├── tasks-service.test.ts
    └── heartbeat.test.ts
```

### 4.1 Responsabilidade por arquivo

1. `index.ts`: bootstrap da extensao e registro de rotas/hooks.
2. `src/config.ts`: leitura e validacao de config/env.
3. `src/auth.ts`: validacao de `Authorization` e `X-Iris-Dashboard-Key`.
4. `src/supabase.ts`: client REST Supabase com headers service role.
5. `src/tasks-repository.ts`: operacoes SQL/REST da entidade tasks.
6. `src/tasks-service.ts`: regras de negocio (soft delete, filtros, ordenacao, transicoes de status).
7. `src/routes-api.ts`: endpoints `/iris-dashboard/api/*`.
8. `src/routes-webhook.ts`: endpoint `/iris-dashboard/webhook/tasks`.
9. `src/heartbeat.ts`: gerador de `memory/HEARTBEAT.md` no boot.
10. `src/system-events.ts`: texto de notificacao para contexto da sessao.
11. `ui/*`: dashboard standalone sem depender de React/Tailwind.
12. `test/*`: cobertura unit/integration minima.

---

## 5. Contrato Completo da API

Base URL da feature: `https://<gateway-host>:18789`

### 5.1 Convencoes

1. API prefix: `/iris-dashboard/api`.
2. JSON UTF-8 em request/response.
3. Envelope padrao de sucesso:

```json
{
  "ok": true,
  "data": {}
}
```

4. Envelope padrao de erro:

```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "titulo is required",
    "details": {}
  }
}
```

5. Codigos de erro padrao: `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `CONFLICT`, `INTERNAL_ERROR`.

### 5.2 Autenticacao

Requisito para rotas mutaveis (`POST`, `PATCH`, `DELETE`):

1. `Authorization: Bearer <gateway-token>` OU
2. `X-Iris-Dashboard-Key: <IRIS_DASHBOARD_API_KEY>`.

Para `POST /iris-dashboard/webhook/tasks`:

1. `X-Iris-Webhook-Secret: <IRIS_DASHBOARD_WEBHOOK_SECRET>` (obrigatorio).
2. Se assinatura Supabase estiver habilitada, validar header de assinatura tambem.

### 5.3 DTO principal (`Task`)

```json
{
  "id": "uuid",
  "titulo": "string",
  "descricao": "string|null",
  "status": "pendente|em_andamento|concluido|cancelado",
  "categoria": "follow_up|backlog|urgente|proximo|outros",
  "prioridade": 1,
  "pessoa": "string|null",
  "origem": "iris|lucas|sistema",
  "vencimento_em": "ISO-8601|null",
  "concluido_em": "ISO-8601|null",
  "concluido_por": "string|null",
  "metadata": {},
  "criado_em": "ISO-8601",
  "atualizado_em": "ISO-8601",
  "deleted_at": "ISO-8601|null"
}
```

### 5.4 Rotas UI (standalone)

#### GET `/iris-dashboard`

1. Finalidade: entregar `ui/index.html`.
2. Auth: opcional (normalmente protegido pela rede/Tailscale).
3. Response `200 text/html`.

#### GET `/iris-dashboard/health`

1. Finalidade: healthcheck da extensao.
2. Auth: sem auth.
3. Response `200`:

```json
{
  "ok": true,
  "data": {
    "service": "iris-dashboard",
    "version": "1.0.0"
  }
}
```

### 5.5 Rotas API

#### GET `/iris-dashboard/api/tasks`

1. Finalidade: listar tarefas com filtro/paginacao.
2. Query params:
   1. `status` (opcional)
   2. `categoria` (opcional)
   3. `pessoa` (opcional)
   4. `search` (opcional; busca em titulo/descricao)
   5. `limit` (opcional; default 50; max 200)
   6. `offset` (opcional; default 0)
   7. `include_deleted` (opcional; default `false`)
   8. `sort_by` (`criado_em|atualizado_em|vencimento_em|prioridade`; default `criado_em`)
   9. `sort_dir` (`asc|desc`; default `desc`)
3. Response `200`:

```json
{
  "ok": true,
  "data": {
    "items": [],
    "page": {
      "limit": 50,
      "offset": 0,
      "total": 0
    }
  }
}
```

#### GET `/iris-dashboard/api/tasks/:id`

1. Finalidade: buscar tarefa por ID.
2. Response `200` com `Task`.
3. Response `404` se nao existir (ou deletada sem `include_deleted=true`).

#### POST `/iris-dashboard/api/tasks`

1. Finalidade: criar tarefa.
2. Body:

```json
{
  "titulo": "Enviar proposta para Emival",
  "descricao": "Conferir valores e anexar PDF",
  "status": "pendente",
  "categoria": "follow_up",
  "prioridade": 2,
  "pessoa": "Emival",
  "origem": "iris",
  "vencimento_em": "2026-03-01T15:00:00Z",
  "metadata": {
    "canal": "whatsapp"
  }
}
```

3. Regras:
   1. `titulo` obrigatorio (1-200 chars).
   2. Campos opcionais recebem defaults do schema.
4. Response `201`:

```json
{
  "ok": true,
  "data": {
    "task": {}
  }
}
```

#### PATCH `/iris-dashboard/api/tasks/:id`

1. Finalidade: atualizar parcialmente.
2. Body (qualquer subset permitido):

```json
{
  "status": "concluido",
  "concluido_por": "lucas",
  "categoria": "follow_up",
  "prioridade": 1
}
```

3. Regras:
   1. Nao permitir alterar `id`, `criado_em`, `atualizado_em` manualmente.
   2. Trigger define consistencia de `concluido_em` e `concluido_por`.
4. Response `200` com `Task` atualizado.

#### DELETE `/iris-dashboard/api/tasks/:id`

1. Finalidade: soft delete (`deleted_at = now()`).
2. Response `200`:

```json
{
  "ok": true,
  "data": {
    "id": "uuid",
    "deleted_at": "2026-02-27T18:30:00.000Z"
  }
}
```

#### POST `/iris-dashboard/api/tasks/:id/restore`

1. Finalidade: desfazer soft delete (`deleted_at = null`).
2. Response `200` com `Task` restaurada.

### 5.6 Rota de Webhook

#### POST `/iris-dashboard/webhook/tasks`

1. Origem: Supabase Database Webhook.
2. Body esperado:

```json
{
  "type": "UPDATE",
  "table": "tasks",
  "schema": "public",
  "record": {
    "id": "uuid",
    "status": "concluido"
  },
  "old_record": {
    "id": "uuid",
    "status": "em_andamento"
  }
}
```

3. Regra de notificacao:
   1. So agir quando `table == tasks`.
   2. So agir quando `old_record.status != 'concluido'` e `record.status == 'concluido'`.
   3. Ignorar updates sem transicao relevante.
4. Response:
   1. `202` quando aceito e processado.
   2. `401/403` quando segredo invalido.
   3. `200` com `ignored=true` para eventos nao relevantes.

Exemplo de sucesso:

```json
{
  "ok": true,
  "data": {
    "accepted": true,
    "event": "task_completed"
  }
}
```

---

## 6. Design System (Baseado em `ui/src/styles/base.css`)

Referencia obrigatoria: `ui/src/styles/base.css`.

A UI da extensao deve herdar o mesmo idioma visual do Control UI. O arquivo `extensions/iris-dashboard/ui/styles.css` deve copiar os tokens abaixo com os mesmos nomes para manter consistencia.

### 6.1 Tokens obrigatorios

1. Superficie/fundo:
   1. `--bg`, `--bg-accent`, `--bg-elevated`, `--bg-hover`, `--bg-muted`
   2. `--card`, `--panel`, `--chrome`
2. Texto:
   1. `--text`, `--text-strong`, `--muted`, `--muted-foreground`
3. Borda/foco:
   1. `--border`, `--border-strong`, `--input`, `--ring`, `--focus-ring`
4. Primario/acento:
   1. `--accent`, `--accent-hover`, `--accent-subtle`, `--accent-foreground`, `--accent-glow`
5. Semanticos:
   1. `--ok`, `--ok-subtle`
   2. `--warn`, `--warn-subtle`
   3. `--danger`, `--danger-subtle`
6. Forma e movimento:
   1. `--radius-sm`, `--radius-md`, `--radius-lg`
   2. `--duration-fast`, `--duration-normal`, `--duration-slow`
   3. `--ease-out`, `--ease-in-out`

### 6.2 Regras de estilo para componentes

1. Pagina:
   1. `background: var(--bg)`
   2. `color: var(--text)`
2. Card de tarefa:
   1. `background: var(--card)`
   2. `border: 1px solid var(--border)`
   3. `border-radius: var(--radius-lg)`
3. Botao primario:
   1. `background: var(--accent)`
   2. hover `var(--accent-hover)`
   3. texto `var(--accent-foreground)`
4. Botao secundario:
   1. `background: var(--secondary, var(--bg-elevated))`
   2. `border: 1px solid var(--border)`
5. Inputs/select:
   1. `background: var(--bg-elevated)`
   2. `border: 1px solid var(--input)`
   3. `:focus-visible` com `box-shadow: var(--focus-ring)`
6. Badges de status:
   1. `pendente`: usar palette neutra (`--bg-muted`, `--text`)
   2. `em_andamento`: usar info/accent
   3. `concluido`: `--ok-subtle` + `--ok`
   4. `cancelado`: `--danger-subtle` + `--danger`

### 6.3 Tema light/dark

1. Dark como default.
2. Implementar override com `[data-theme="light"]` seguindo o padrao de `ui/src/styles/base.css`.
3. Respeitar `prefers-reduced-motion: reduce` para animacoes.

### 6.4 Animacoes permitidas

Usar apenas animacoes coerentes com base.css:

1. `dashboard-enter` para entrada de cards/lista.
2. `shimmer` para skeleton/loading.
3. `fade-in` para toasts.

---

## 7. Configuracao da Extensao (openclaw.plugin.json)

Campos minimos de configuracao:

1. `supabaseUrl` (obrigatorio)
2. `supabaseServiceKey` (obrigatorio, sensivel)
3. `supabaseAnonKey` (opcional; apenas se UI usar realtime direto)
4. `dashboardApiKey` (obrigatorio, sensivel)
5. `webhookSecret` (obrigatorio, sensivel)
6. `heartbeatOutputFile` (default: `memory/HEARTBEAT.md`)
7. `heartbeatSessionKey` (session que recebera system events)

---

## 8. Plano de Execucao para Novo Agente

### Fase A - Scaffolding

1. Criar estrutura de arquivos conforme tree da Secao 4.
2. Preencher `openclaw.plugin.json` e `package.json`.

### Fase B - Banco

1. Aplicar migration da Secao 3 no Supabase.
2. Validar constraints, indices, trigger e RLS.
3. Habilitar realtime e webhook.

### Fase C - API

1. Implementar auth middleware local da extensao.
2. Implementar rotas de Secao 5.5.
3. Implementar rota webhook da Secao 5.6.

### Fase D - UI

1. Implementar `ui/index.html`, `ui/app.js`, `ui/api.js`, `ui/styles.css`.
2. Aplicar design system da Secao 6.
3. Conectar CRUD + filtros + estados de loading/empty.

### Fase E - Heartbeat e Notificacao

1. Implementar gerador de HEARTBEAT em `src/heartbeat.ts`.
2. Acionar no hook `gateway_start` (ou `session_start`, conforme necessidade).
3. Webhook deve gerar system event para sessao configurada.

### Fase F - Testes e Handoff

1. Unit tests: validacao, service, heartbeat.
2. Integration tests: rotas API e webhook.
3. Validacao manual: create/update/complete/delete/restore + realtime.
4. Atualizar README da extensao com setup e troubleshooting.

---

## 9. Checklist de Aceite (Definition of Done)

1. `extensions/iris-dashboard/migration.sql` aplicado sem erro em banco limpo e banco existente.
2. Todas as rotas especificadas em Secao 5 respondem conforme contrato.
3. Soft delete e restore funcionando.
4. Webhook processa apenas transicao real para `concluido`.
5. HEARTBEAT.md gerado no boot com tarefas nao concluidas.
6. UI responsiva em desktop e mobile.
7. UI usa tokens de `ui/src/styles/base.css`.
8. Nenhum arquivo do core alterado no MVP (`src/**`, `ui/**`).
9. Testes minimos da extensao passando.
10. Documentacao da extensao suficiente para operacao sem contexto adicional.

---

## 10. Riscos e Mitigacoes

1. Realtime indisponivel no browser:
   1. Mitigacao: fallback para polling de `GET /iris-dashboard/api/tasks` a cada 5s.
2. Webhook falhando por assinatura:
   1. Mitigacao: log estruturado de cabecalhos e corpo + endpoint `health`.
3. Vazamento de endpoint mutavel:
   1. Mitigacao: chave obrigatoria (`dashboardApiKey`) + segredo webhook.
4. Divergencia visual com Control UI:
   1. Mitigacao: copiar tokens obrigatorios da Secao 6.

---

## 11. Observacoes Finais

1. Este documento e intencionalmente prescritivo para handoff sem contexto.
2. Se houver necessidade de embed no Control UI nativo, tratar como fase posterior ao MVP.
3. Quaisquer alteracoes de core devem ser feitas em PR separado e justificadas por necessidade tecnica real.
