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
