-- Chat History (Supabase) — migration
-- Run this in your Supabase SQL Editor before enabling the plugin.

create table if not exists public.chat_messages (
  id            uuid primary key default gen_random_uuid(),
  timestamp     timestamptz not null default now(),
  sender        text not null,
  sender_name   text,
  chat_id       text not null,
  direction     text not null check (direction in ('inbound', 'outbound')),
  body          text,
  media_url     text,
  media_type    text,
  transcription text,
  session_key   text,
  message_id    text,
  channel       text,
  is_read       boolean not null default false,
  replied       boolean not null default false
);

-- Index for efficient per-chat queries (ordered by time)
create index if not exists chat_messages_chat_id_timestamp_idx
  on public.chat_messages (chat_id, timestamp desc);

-- Index for transcription updates by message_id
create index if not exists chat_messages_message_id_idx
  on public.chat_messages (message_id)
  where message_id is not null;

-- Enable Row Level Security
alter table public.chat_messages enable row level security;

-- Allow read access for anon/authenticated roles (monitoring dashboard)
-- Adjust this policy to restrict access as needed.
create policy "Allow read for authenticated users"
  on public.chat_messages
  for select
  using (true);

-- Enable Realtime for this table (run in Supabase dashboard or via API)
-- Supabase Dashboard > Database > Replication > chat_messages > enable
