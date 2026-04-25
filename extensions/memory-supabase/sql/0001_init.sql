-- ---------------------------------------------------------------------------
-- memory-supabase :: schema
--
-- Run once against your Supabase project, e.g.:
--   psql "$SUPABASE_DB_URL" -f extensions/memory-supabase/sql/0001_init.sql
--
-- Re-running is safe: every statement is idempotent.
-- ---------------------------------------------------------------------------

create extension if not exists vector;
create extension if not exists pgcrypto;

create table if not exists memory_items (
  id          uuid primary key default gen_random_uuid(),
  user_id     text not null,
  channel     text not null,
  source_id   text,
  role        text not null check (role in ('inbound', 'outbound', 'note')),
  content     text not null,
  tags        text[] not null default '{}',
  metadata    jsonb not null default '{}'::jsonb,
  embedding   vector(1536) not null,
  consent     boolean not null default true,
  created_at  timestamptz not null default now()
);

create index if not exists memory_items_embedding_ivf
  on memory_items using ivfflat (embedding vector_cosine_ops) with (lists = 100);
create index if not exists memory_items_user_created
  on memory_items (user_id, created_at desc);
create index if not exists memory_items_tags_gin
  on memory_items using gin (tags);
create index if not exists memory_items_channel
  on memory_items (channel);

-- De-duplicate inbound auto-indexing so the same gmail/whatsapp message id
-- can never produce two rows.
create unique index if not exists memory_items_source_uniq
  on memory_items (channel, source_id) where source_id is not null;

-- ---------------------------------------------------------------------------
-- Vector similarity search RPC
--
-- Returns the top-k items above a cosine-similarity floor.
-- ---------------------------------------------------------------------------

create or replace function match_memory_items(
  p_user_id   text,
  p_query     vector(1536),
  p_k         int default 8,
  p_min_score real default 0.3
)
returns table (
  id          uuid,
  user_id     text,
  channel     text,
  source_id   text,
  role        text,
  content     text,
  tags        text[],
  metadata    jsonb,
  consent     boolean,
  created_at  timestamptz,
  score       real
)
language sql stable
as $$
  select m.id,
         m.user_id,
         m.channel,
         m.source_id,
         m.role,
         m.content,
         m.tags,
         m.metadata,
         m.consent,
         m.created_at,
         (1 - (m.embedding <=> p_query))::real as score
  from   memory_items m
  where  m.user_id = p_user_id
    and  m.consent = true
    and  (1 - (m.embedding <=> p_query)) >= p_min_score
  order  by m.embedding <=> p_query
  limit  p_k;
$$;
