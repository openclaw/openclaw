CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  event_type TEXT NOT NULL,
  source TEXT NOT NULL,
  actor TEXT,
  conversation_id TEXT,
  parent_event_id TEXT,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_conversation_id ON events(conversation_id);

CREATE TABLE IF NOT EXISTS reflections (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  source_event_id TEXT,
  reflection_text TEXT NOT NULL,
  durable_claims_json TEXT NOT NULL,
  uncertainties_json TEXT NOT NULL,
  interdisciplinary_links_json TEXT NOT NULL,
  nca_signal TEXT,
  creative_fragment TEXT,
  memory_candidate_score REAL,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (source_event_id) REFERENCES events(id)
);

CREATE INDEX IF NOT EXISTS idx_reflections_created_at ON reflections(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reflections_source_event_id ON reflections(source_event_id);

CREATE TABLE IF NOT EXISTS compaction_experiments (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  model_id TEXT NOT NULL,
  curriculum_stage INTEGER NOT NULL,
  approach TEXT NOT NULL,
  name TEXT,
  segment_window INTEGER,
  kv_reduction_ratio REAL,
  throughput_mult REAL,
  accuracy_delta REAL,
  leakage_risk_score REAL,
  tokens_in INTEGER,
  tokens_out INTEGER,
  notes_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running'
);

CREATE INDEX IF NOT EXISTS idx_compaction_experiments_created_at
  ON compaction_experiments(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_compaction_experiments_model_id
  ON compaction_experiments(model_id);

CREATE TABLE IF NOT EXISTS compaction_blocks (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  segment_index INTEGER NOT NULL,
  curriculum_stage INTEGER NOT NULL,
  segment_text TEXT NOT NULL,
  memento_text TEXT,
  source_prompt TEXT,
  expected_answer TEXT,
  side_channel_hint INTEGER,
  source_event_id TEXT,
  source_event_turn INTEGER,
  notes_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (experiment_id) REFERENCES compaction_experiments(id) ON DELETE CASCADE,
  FOREIGN KEY (source_event_id) REFERENCES events(id)
);

CREATE INDEX IF NOT EXISTS idx_compaction_blocks_created_at
  ON compaction_blocks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_compaction_blocks_experiment
  ON compaction_blocks(experiment_id);

CREATE TABLE IF NOT EXISTS promotions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  reflection_id TEXT,
  claim_text TEXT NOT NULL,
  promoted_to TEXT NOT NULL,
  decision TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  checkpoint_id TEXT,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (reflection_id) REFERENCES reflections(id)
);

CREATE INDEX IF NOT EXISTS idx_promotions_created_at ON promotions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_promotions_reflection_id ON promotions(reflection_id);

CREATE TABLE IF NOT EXISTS shadow_runs (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  prompt_hash TEXT,
  teacher_output_json TEXT NOT NULL,
  candidate_outputs_json TEXT NOT NULL,
  judge_scores_json TEXT NOT NULL,
  chosen_candidate_id TEXT,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shadow_runs_created_at ON shadow_runs(created_at DESC);

CREATE TABLE IF NOT EXISTS eval_runs (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  suite_name TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT,
  score_summary_json TEXT NOT NULL,
  artifact_path TEXT,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_eval_runs_created_at ON eval_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_eval_runs_suite_name ON eval_runs(suite_name);

CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  base_model_id TEXT NOT NULL,
  adapter_id TEXT,
  nca_snapshot_id TEXT,
  status TEXT NOT NULL,
  lineage_json TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_created_at ON checkpoints(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_checkpoints_status ON checkpoints(status);

CREATE TABLE IF NOT EXISTS rollback_events (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  from_checkpoint_id TEXT,
  to_checkpoint_id TEXT,
  reason TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (from_checkpoint_id) REFERENCES checkpoints(id),
  FOREIGN KEY (to_checkpoint_id) REFERENCES checkpoints(id)
);

CREATE INDEX IF NOT EXISTS idx_rollback_events_created_at ON rollback_events(created_at DESC);

CREATE TABLE IF NOT EXISTS nca_snapshots (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  parent_snapshot_id TEXT,
  checkpoint_id TEXT,
  motif_summary TEXT,
  drift_signal REAL,
  anomaly_flags_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (checkpoint_id) REFERENCES checkpoints(id)
);

CREATE INDEX IF NOT EXISTS idx_nca_snapshots_created_at ON nca_snapshots(created_at DESC);

CREATE TABLE IF NOT EXISTS adapter_registry (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  base_model_id TEXT NOT NULL,
  adapter_path TEXT NOT NULL,
  train_corpus_lineage_json TEXT NOT NULL,
  validation_summary_json TEXT NOT NULL,
  deployment_state TEXT NOT NULL,
  merge_state TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_adapter_registry_created_at ON adapter_registry(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_adapter_registry_base_model_id ON adapter_registry(base_model_id);

CREATE TABLE IF NOT EXISTS document_corpora (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  title TEXT NOT NULL,
  root_path TEXT NOT NULL,
  manifest_path TEXT,
  vector_db_path TEXT,
  location_index_path TEXT,
  document_count INTEGER NOT NULL DEFAULT 0,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_document_corpora_updated_at
  ON document_corpora(updated_at DESC);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  corpus_id TEXT NOT NULL,
  hash8 TEXT NOT NULL,
  title TEXT NOT NULL,
  topic TEXT,
  published TEXT,
  updated TEXT,
  arxiv_id TEXT,
  abstract_url TEXT,
  source_url TEXT,
  pdf_path TEXT,
  raw_pdf_path TEXT,
  text_path TEXT,
  markdown_path TEXT,
  record_path TEXT,
  authors_json TEXT NOT NULL,
  categories_json TEXT NOT NULL,
  summary_text TEXT,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (corpus_id) REFERENCES document_corpora(id) ON DELETE CASCADE,
  UNIQUE (corpus_id, hash8)
);

CREATE INDEX IF NOT EXISTS idx_documents_corpus_id ON documents(corpus_id);
CREATE INDEX IF NOT EXISTS idx_documents_topic ON documents(topic);
CREATE INDEX IF NOT EXISTS idx_documents_published ON documents(published DESC);
CREATE INDEX IF NOT EXISTS idx_documents_hash8 ON documents(hash8);

CREATE TABLE IF NOT EXISTS document_chunks (
  id TEXT PRIMARY KEY,
  corpus_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  source_chunk_id TEXT,
  chunk_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  vector_dim INTEGER,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (corpus_id) REFERENCES document_corpora(id) ON DELETE CASCADE,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
  UNIQUE (document_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_document_chunks_corpus_id ON document_chunks(corpus_id);
CREATE INDEX IF NOT EXISTS idx_document_chunks_document_id ON document_chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_document_chunks_source_chunk_id ON document_chunks(source_chunk_id);

CREATE VIRTUAL TABLE IF NOT EXISTS document_chunks_fts USING fts5(
  chunk_id UNINDEXED,
  document_id UNINDEXED,
  corpus_id UNINDEXED,
  hash8 UNINDEXED,
  title,
  topic,
  text
);
