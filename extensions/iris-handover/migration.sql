-- Migration: iris-handover Supabase storage + vector search
-- Run this in Supabase SQL Editor

-- Enable pgvector if not already
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS handovers (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  session_key   text NOT NULL,
  agent_id      text NOT NULL DEFAULT 'main',
  content       text NOT NULL,
  char_count    integer NOT NULL DEFAULT 0,
  token_count   integer,
  model         text,
  embedding     vector(1536),
  created_at    timestamptz DEFAULT now() NOT NULL
);

-- Adicionar coluna embedding se tabela ja existe
ALTER TABLE handovers ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_handovers_session_key ON handovers (session_key);
CREATE INDEX IF NOT EXISTS idx_handovers_created_at ON handovers (created_at DESC);

-- HNSW index for fast similarity search
CREATE INDEX IF NOT EXISTS idx_handovers_embedding ON handovers
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- RLS
ALTER TABLE handovers ENABLE ROW LEVEL SECURITY;

-- Drop policies if they exist (idempotent)
DROP POLICY IF EXISTS service_role_all ON handovers;
DROP POLICY IF EXISTS anon_read ON handovers;

CREATE POLICY service_role_all ON handovers
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY anon_read ON handovers
  FOR SELECT TO anon
  USING (true);

-- Helper function: search handovers by similarity
CREATE OR REPLACE FUNCTION search_handovers(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.5,
  match_count int DEFAULT 5
)
RETURNS TABLE (
  id uuid,
  session_key text,
  content text,
  char_count integer,
  model text,
  created_at timestamptz,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    h.id,
    h.session_key,
    h.content,
    h.char_count,
    h.model,
    h.created_at,
    1 - (h.embedding <=> query_embedding) AS similarity
  FROM handovers h
  WHERE h.embedding IS NOT NULL
    AND 1 - (h.embedding <=> query_embedding) > match_threshold
  ORDER BY h.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
