-- ---------------------------------------------------------------------------
-- memory-supabase :: daily journal
--
-- Stores one summary row per (user_id, date) and links back to the memory_item
-- that holds the indexed/embedded full text.
-- ---------------------------------------------------------------------------

create table if not exists daily_journal (
  user_id     text not null,
  date        date not null,
  summary     text not null,
  highlights  jsonb not null default '[]'::jsonb,
  memory_id   uuid references memory_items(id) on delete set null,
  created_at  timestamptz not null default now(),
  primary key (user_id, date)
);

-- Make upserts on (date) work for the single-tenant case
create unique index if not exists daily_journal_date_uniq on daily_journal (date);
