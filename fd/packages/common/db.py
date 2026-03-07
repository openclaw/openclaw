from __future__ import annotations

import sqlite3
from pathlib import Path


def connect(sqlite_path: str) -> sqlite3.Connection:
    Path(sqlite_path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(sqlite_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS audit_log (
          id TEXT PRIMARY KEY,
          ts INTEGER NOT NULL,
          action TEXT NOT NULL,
          target TEXT NOT NULL,
          correlation_id TEXT,
          payload_json TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS idempotency (
          key TEXT PRIMARY KEY,
          ts INTEGER NOT NULL
        )
        """
    )

    # Offer intent captured pre-call (ManyChat intake)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS offer_intents (
          correlation_id TEXT PRIMARY KEY,
          ts INTEGER NOT NULL,
          brand TEXT NOT NULL,
          instagram_handle TEXT,
          email TEXT,
          phone TEXT,
          offer_intent TEXT,
          budget TEXT,
          timeline TEXT,
          raw_answers_json TEXT NOT NULL
        )
        """
    )

    # Payments tracked from Stripe webhook events (source of truth for "paid")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS payments (
          payment_id TEXT PRIMARY KEY,
          ts INTEGER NOT NULL,
          provider TEXT NOT NULL,
          provider_event_id TEXT NOT NULL,
          status TEXT NOT NULL,
          amount_total INTEGER,
          currency TEXT,
          customer_email TEXT,
          metadata_json TEXT NOT NULL
        )
        """
    )

    # Fulfillment jobs (Trello + Dropbox later)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS fulfillment_jobs (
          job_id TEXT PRIMARY KEY,
          ts INTEGER NOT NULL,
          brand TEXT NOT NULL,
          correlation_id TEXT,
          ghl_contact_id TEXT,
          customer_email TEXT,
          offer_key TEXT,
          trello_board_id TEXT,
          status TEXT NOT NULL,
          metadata_json TEXT NOT NULL
        )
        """
    )

    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_fulfillment_board_id
        ON fulfillment_jobs (trello_board_id)
        """
    )

    # Fast local lookup: GHL contact -> Trello board (and primary card)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS contact_board_map (
          ghl_contact_id TEXT PRIMARY KEY,
          trello_board_id TEXT NOT NULL,
          primary_card_id TEXT,
          correlation_id TEXT,
          ts INTEGER NOT NULL
        )
        """
    )

    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_contact_board_map_board
        ON contact_board_map (trello_board_id)
        """
    )

    # Registry of Trello webhooks created per board (for cleanup)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS trello_webhooks (
          trello_webhook_id TEXT PRIMARY KEY,
          trello_board_id TEXT NOT NULL,
          callback_url TEXT NOT NULL,
          is_active INTEGER NOT NULL,
          correlation_id TEXT,
          ts INTEGER NOT NULL
        )
        """
    )

    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_trello_webhooks_board
        ON trello_webhooks (trello_board_id)
        """
    )

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS team_members (
          member_id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          role TEXT NOT NULL,
          is_active INTEGER NOT NULL,
          capacity_points INTEGER NOT NULL,
          skills_json TEXT NOT NULL,
          ts INTEGER NOT NULL
        )
        """
    )

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS assignments (
          assignment_id TEXT PRIMARY KEY,
          ts INTEGER NOT NULL,
          trello_board_id TEXT NOT NULL,
          card_id TEXT NOT NULL,
          member_id TEXT NOT NULL,
          reason TEXT NOT NULL,
          correlation_id TEXT,
          status TEXT NOT NULL
        )
        """
    )

    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_assignments_card
        ON assignments (card_id, ts)
        """
    )

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS intake_requests (
          request_id TEXT PRIMARY KEY,
          ts INTEGER NOT NULL,
          source TEXT NOT NULL,
          source_event_id TEXT NOT NULL,
          ghl_contact_id TEXT,
          trello_board_id TEXT,
          client_card_id TEXT,
          internal_card_id TEXT,
          request_type TEXT NOT NULL,
          priority TEXT NOT NULL,
          status TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          correlation_id TEXT
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_intake_requests_client_board
        ON intake_requests (trello_board_id, ts)
        """
    )

    # Canonical work order state (V2: unifies intake_requests + assignments)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS work_orders (
          work_order_id TEXT PRIMARY KEY,
          ts INTEGER NOT NULL,
          source TEXT NOT NULL,
          source_event_id TEXT NOT NULL,
          correlation_id TEXT,
          request_type TEXT NOT NULL,
          priority TEXT NOT NULL,
          assigned_role TEXT,
          assigned_to TEXT,
          assigned_at INTEGER,
          status TEXT NOT NULL,
          client_board_id TEXT,
          client_card_id TEXT,
          internal_card_id TEXT,
          ghl_contact_id TEXT,
          payload_json TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_work_orders_client_board
        ON work_orders (client_board_id, ts)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_work_orders_source_event
        ON work_orders (source, source_event_id)
        """
    )

    # Load-bearing capacity table for deterministic assignment
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS team_capacity (
          assignee_id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          roles_json TEXT NOT NULL,
          weight INTEGER NOT NULL DEFAULT 1,
          active_jobs INTEGER NOT NULL DEFAULT 0,
          enabled INTEGER NOT NULL DEFAULT 1
        )
        """
    )

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS lifecycle_timeline (
          timeline_id TEXT PRIMARY KEY,
          ts INTEGER NOT NULL,
          trello_board_id TEXT NOT NULL,
          primary_card_id TEXT,
          event_type TEXT NOT NULL,
          event_key TEXT NOT NULL,
          correlation_id TEXT,
          payload_json TEXT NOT NULL,
          posted_to_trello INTEGER NOT NULL,
          post_error TEXT
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_lifecycle_timeline_board
        ON lifecycle_timeline (trello_board_id, ts)
        """
    )

    # V2 timeline events table (used by write_timeline API)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS timeline_events (
          event_id TEXT PRIMARY KEY,
          ts INTEGER NOT NULL,
          trello_board_id TEXT,
          primary_card_id TEXT,
          event_type TEXT NOT NULL,
          event_key TEXT NOT NULL,
          title TEXT NOT NULL,
          human_json TEXT NOT NULL,
          machine_json TEXT NOT NULL,
          correlation_id TEXT
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_timeline_events_board
        ON timeline_events (trello_board_id, ts)
        """
    )

    # GHL contact → Trello board resolution index
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS ghl_contact_index (
          ghl_contact_id TEXT PRIMARY KEY,
          email TEXT,
          phone TEXT,
          trello_board_id TEXT,
          trello_webhook_id TEXT,
          updated_ts INTEGER
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_ghl_contact_email ON ghl_contact_index(email)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_ghl_contact_phone ON ghl_contact_index(phone)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_ghl_contact_board ON ghl_contact_index(trello_board_id)"
    )

    # Trello board ↔ GHL contact link + lifecycle card + webhook
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS trello_board_links (
          trello_board_id TEXT PRIMARY KEY,
          ghl_contact_id TEXT,
          trello_webhook_id TEXT,
          lifecycle_card_id TEXT,
          status TEXT,
          created_ts INTEGER,
          updated_ts INTEGER
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_board_links_contact ON trello_board_links(ghl_contact_id)"
    )

    # V2 offer intents for Stripe checkout flow
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS checkout_offer_intents (
          offer_intent_id TEXT PRIMARY KEY,
          status TEXT,
          ghl_contact_id TEXT,
          email TEXT,
          phone TEXT,
          offer_code TEXT,
          amount_cents INTEGER,
          currency TEXT,
          correlation_id TEXT,
          stripe_checkout_session_id TEXT,
          stripe_payment_intent_id TEXT,
          trello_board_id TEXT,
          created_ts INTEGER,
          updated_ts INTEGER
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_checkout_offer_contact ON checkout_offer_intents(ghl_contact_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_checkout_offer_session ON checkout_offer_intents(stripe_checkout_session_id)"
    )

    # Bidirectional stage sync echo-suppression state
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS stage_sync_state (
          entity_key TEXT PRIMARY KEY,
          last_source TEXT,
          last_ts INTEGER,
          last_value TEXT
        )
        """
    )

    # Card state tracking (dueComplete, release date, list position)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS trello_card_state (
          trello_card_id TEXT PRIMARY KEY,
          trello_board_id TEXT,
          trello_list_id TEXT,
          due_complete INTEGER DEFAULT 0,
          release_date_iso TEXT,
          last_seen_ts TEXT,
          updated_ts TEXT
        )
        """
    )

    # Scheduled actions (release-date publishing, deferred moves)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS scheduled_actions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          action_type TEXT NOT NULL,
          run_at_iso TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          created_ts TEXT,
          updated_ts TEXT
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_scheduled_actions_status_run ON scheduled_actions(status, run_at_iso)"
    )

    # Sync stamps: loop prevention + out-of-order guard for bidirectional sync
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS sync_stamps (
          pair_key TEXT PRIMARY KEY,
          last_event_id TEXT,
          last_origin TEXT,
          last_action_date TEXT,
          updated_ts TEXT
        )
        """
    )

    # Add last_action_date to trello_card_state (safe: no-op if already exists)
    try:
        conn.execute("ALTER TABLE trello_card_state ADD COLUMN last_action_date TEXT")
    except Exception:
        pass  # column already exists

    # Work order links: bidirectional mapping client card <-> internal card
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS work_order_links (
          client_card_id TEXT PRIMARY KEY,
          client_board_id TEXT,
          internal_card_id TEXT,
          internal_board_id TEXT,
          status TEXT DEFAULT 'active',
          created_ts TEXT,
          updated_ts TEXT
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_work_order_links_internal ON work_order_links(internal_card_id)"
    )

    # System state: key-value store for cooldown / circuit breaker / flags
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS system_state (
          key TEXT PRIMARY KEY,
          value TEXT,
          updated_ts TEXT
        )
        """
    )

    # Job run telemetry: outcomes of batch/recurring jobs
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS job_runs (
          id TEXT PRIMARY KEY,
          job_name TEXT NOT NULL,
          status TEXT NOT NULL,
          stop_reason TEXT,
          started_ts TEXT,
          finished_ts TEXT,
          stats_json TEXT,
          correlation_id TEXT
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_job_runs_job_name_finished ON job_runs(job_name, finished_ts)"
    )

    # Attribution touchpoints (campaign → DM → booking → Stripe → fulfillment)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS attribution_touchpoints (
          touch_id TEXT PRIMARY KEY,
          contact_key TEXT NOT NULL,
          touch_type TEXT NOT NULL,
          source TEXT NOT NULL,
          campaign TEXT,
          utm_json TEXT,
          ts TEXT NOT NULL
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_attr_touch_contact ON attribution_touchpoints(contact_key, ts)"
    )

    # Lead attribution (first/last touch + primary campaign)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS lead_attribution (
          contact_key TEXT PRIMARY KEY,
          first_touch_id TEXT,
          last_touch_id TEXT,
          primary_campaign TEXT,
          confidence TEXT,
          updated_at TEXT
        )
        """
    )

    # Revenue attribution (Stripe event → campaign)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS revenue_attribution (
          stripe_event_id TEXT PRIMARY KEY,
          contact_key TEXT NOT NULL,
          amount INTEGER NOT NULL,
          currency TEXT NOT NULL,
          campaign TEXT,
          ts TEXT NOT NULL
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_rev_attr_contact ON revenue_attribution(contact_key)"
    )

    # Setter activity log (appointment setter OS)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS setter_activity_log (
          activity_id TEXT PRIMARY KEY,
          setter_id TEXT NOT NULL,
          activity_type TEXT NOT NULL,
          contact_key TEXT,
          details_json TEXT,
          ts TEXT NOT NULL
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_setter_activity_setter ON setter_activity_log(setter_id, ts)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_setter_activity_contact ON setter_activity_log(contact_key, ts)"
    )

    # ── AgencyU v2 tables (020-023 migrations) ──

    # 020: AgencyU leads (qualified lead pipeline)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS agencyu_leads (
          id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          ghl_contact_id TEXT,
          manychat_contact_id TEXT,
          instagram_handle TEXT,
          email TEXT,
          phone TEXT,
          stage TEXT NOT NULL,
          revenue_tier TEXT,
          pain_point TEXT,
          source TEXT,
          campaign TEXT,
          engaged_flags TEXT,
          appointment_ts TEXT,
          attribution_json TEXT,
          last_touch_ts TEXT,
          last_touch_channel TEXT,
          last_touch_note TEXT
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_agencyu_leads_ghl_contact_id ON agencyu_leads(ghl_contact_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_agencyu_leads_manychat_contact_id ON agencyu_leads(manychat_contact_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_agencyu_leads_campaign ON agencyu_leads(campaign)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_agencyu_leads_stage ON agencyu_leads(stage)")

    # 021: Setter daily metrics + lead touch log
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS setter_daily_metrics (
          id TEXT PRIMARY KEY,
          date TEXT NOT NULL,
          setter_id TEXT NOT NULL,
          dms_sent INTEGER NOT NULL DEFAULT 0,
          convos_started INTEGER NOT NULL DEFAULT 0,
          followups_sent INTEGER NOT NULL DEFAULT 0,
          booked_calls INTEGER NOT NULL DEFAULT 0,
          notes_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_setter_daily_metrics_date_setter ON setter_daily_metrics(date, setter_id)"
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS lead_touch_log (
          id TEXT PRIMARY KEY,
          lead_id TEXT NOT NULL,
          ts TEXT NOT NULL,
          channel TEXT NOT NULL,
          action TEXT NOT NULL,
          outcome TEXT,
          note TEXT,
          correlation_id TEXT,
          created_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_lead_touch_log_lead_id ON lead_touch_log(lead_id)")

    # 022: Notion mirrors
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS notion_mirrors (
          id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          mirror_type TEXT NOT NULL,
          ghl_contact_id TEXT,
          lead_id TEXT,
          client_id TEXT,
          notion_page_id TEXT NOT NULL,
          notion_db_id TEXT,
          last_sync_at TEXT,
          last_error TEXT,
          UNIQUE(mirror_type, notion_page_id)
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_notion_mirrors_ghl_contact_id ON notion_mirrors(ghl_contact_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_notion_mirrors_lead_id ON notion_mirrors(lead_id)")

    # 023: Campaigns + campaign contacts
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS campaigns (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          utm_campaign TEXT NOT NULL,
          start_ts TEXT,
          end_ts TEXT,
          notes TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS ux_campaigns_type_utm_campaign ON campaigns(type, utm_campaign)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS campaign_contacts (
          id TEXT PRIMARY KEY,
          campaign_id TEXT NOT NULL,
          ghl_contact_id TEXT,
          manychat_contact_id TEXT,
          lead_id TEXT,
          status TEXT,
          joined_ts TEXT,
          created_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_campaign_contacts_campaign_id ON campaign_contacts(campaign_id)")

    # ── AgencyOS v3 tables (024 migration) ──

    # Notion bindings (database/page ID registry)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS notion_bindings (
          id TEXT PRIMARY KEY,
          binding_type TEXT NOT NULL,
          notion_object_id TEXT NOT NULL,
          label TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(binding_type, notion_object_id)
        )
        """
    )

    # Cross-system identity map
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS id_map (
          id TEXT PRIMARY KEY,
          domain TEXT NOT NULL,
          external_id TEXT NOT NULL,
          notion_page_id TEXT,
          ghl_contact_id TEXT,
          trello_card_id TEXT,
          manychat_user_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(domain, external_id)
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_id_map_notion ON id_map(notion_page_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_id_map_ghl ON id_map(ghl_contact_id)")

    # Work order mirror (Trello card → Notion page)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS work_order_mirror (
          id TEXT PRIMARY KEY,
          trello_card_id TEXT NOT NULL,
          notion_page_id TEXT,
          board_id TEXT,
          status TEXT NOT NULL,
          title TEXT,
          assigned_to TEXT,
          due_date TEXT,
          last_synced_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(trello_card_id)
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_wom_notion ON work_order_mirror(notion_page_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_wom_status ON work_order_mirror(status)")

    # Attribution snapshot (end-to-end UTM → revenue)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS attribution_snapshot (
          id TEXT PRIMARY KEY,
          contact_key TEXT NOT NULL,
          utm_source TEXT,
          utm_medium TEXT,
          utm_campaign TEXT,
          utm_content TEXT,
          utm_term TEXT,
          first_touch_ts TEXT,
          last_touch_ts TEXT,
          manychat_user_id TEXT,
          ghl_contact_id TEXT,
          stripe_payment_id TEXT,
          revenue_cents INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_attr_snap_contact ON attribution_snapshot(contact_key)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_attr_snap_campaign ON attribution_snapshot(utm_campaign)")

    # ClickFunnels events (VSL → Application → Booking funnel)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS clickfunnels_events (
          id TEXT PRIMARY KEY,
          event_type TEXT NOT NULL,
          funnel_id TEXT,
          page_id TEXT,
          email TEXT,
          name TEXT,
          phone TEXT,
          utm_source TEXT,
          utm_medium TEXT,
          utm_campaign TEXT,
          utm_content TEXT,
          payload_json TEXT NOT NULL,
          correlation_id TEXT,
          created_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_cf_events_email ON clickfunnels_events(email)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_cf_events_type ON clickfunnels_events(event_type)")

    # ── Canonical entity store (AgencyOS sync layer) ──

    # Canonical entities: one row per mirrored object (client/lead/task/invoice/etc)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS canonical_entities (
          id TEXT PRIMARY KEY,
          entity_type TEXT NOT NULL,
          canonical_key TEXT,
          data_json TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          is_deleted INTEGER NOT NULL DEFAULT 0,
          deleted_at TEXT,
          last_seen_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_ce_entity_type ON canonical_entities(entity_type)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_ce_canonical_key ON canonical_entities(canonical_key)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_ce_content_hash ON canonical_entities(content_hash)")

    # Entity mappings: multiple source IDs map to one canonical entity
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS entity_mappings (
          id TEXT PRIMARY KEY,
          entity_id TEXT NOT NULL REFERENCES canonical_entities(id) ON DELETE CASCADE,
          source_system TEXT NOT NULL,
          source_type TEXT NOT NULL,
          source_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(source_system, source_type, source_id)
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_em_entity_id ON entity_mappings(entity_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_em_source ON entity_mappings(source_system, source_type, source_id)")

    # Notion mirror state: per-entity sync tracking for drift detection
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS notion_mirror_state (
          entity_id TEXT PRIMARY KEY REFERENCES canonical_entities(id) ON DELETE CASCADE,
          notion_database_key TEXT NOT NULL,
          notion_database_id TEXT,
          notion_page_id TEXT,
          last_mirrored_at TEXT,
          last_mirrored_hash TEXT,
          last_notion_snapshot_json TEXT,
          sync_health TEXT NOT NULL DEFAULT 'ok',
          last_error TEXT,
          locked INTEGER NOT NULL DEFAULT 0,
          override_owner TEXT
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_nms_db_key ON notion_mirror_state(notion_database_key)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_nms_page_id ON notion_mirror_state(notion_page_id)")

    # Conflict log: records drift conflicts requiring human review
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS conflict_log (
          id TEXT PRIMARY KEY,
          sync_run_id TEXT,
          entity_id TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          field_name TEXT NOT NULL,
          policy_applied TEXT NOT NULL,
          source_value_json TEXT,
          notion_value_json TEXT,
          resolved_value_json TEXT,
          created_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_cl_entity_id ON conflict_log(entity_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_cl_sync_run_id ON conflict_log(sync_run_id)")

    # Sync runs: per-connector run telemetry
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS sync_runs (
          id TEXT PRIMARY KEY,
          source_system TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'running',
          started_at TEXT NOT NULL,
          finished_at TEXT,
          stats_json TEXT,
          error_text TEXT
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sr_source ON sync_runs(source_system, started_at)")

    # ── System snapshots (audit trail for sync/heal operations) ──
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS system_snapshots (
          key TEXT NOT NULL,
          value_json TEXT NOT NULL,
          snapshot_type TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_ss_key ON system_snapshots(key, created_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_ss_type ON system_snapshots(snapshot_type)")

    # ── Event replay buffer (last 24h webhooks for replay) ──
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS event_replay_buffer (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          correlation_id TEXT,
          received_at TEXT NOT NULL,
          replayed INTEGER NOT NULL DEFAULT 0,
          replayed_at TEXT
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_erb_source ON event_replay_buffer(source, received_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_erb_replayed ON event_replay_buffer(replayed, received_at)")

    # ── Team capacity (assignment engine + load balancing) ──
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS team_capacity_v2 (
          team_member_id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          role TEXT,
          max_concurrent_work INTEGER NOT NULL DEFAULT 5,
          current_open_work INTEGER NOT NULL DEFAULT 0,
          enabled INTEGER NOT NULL DEFAULT 1,
          updated_at TEXT NOT NULL
        )
        """
    )

    # ── Revenue forecast model ──
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS revenue_forecast (
          id TEXT PRIMARY KEY,
          forecast_month TEXT NOT NULL,
          active_mrr INTEGER NOT NULL DEFAULT 0,
          pipeline_value INTEGER NOT NULL DEFAULT 0,
          booked_calls INTEGER NOT NULL DEFAULT 0,
          historical_close_rate REAL NOT NULL DEFAULT 0.0,
          projected_new_revenue INTEGER NOT NULL DEFAULT 0,
          total_forecast INTEGER NOT NULL DEFAULT 0,
          notes TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS ux_rf_month ON revenue_forecast(forecast_month)")

    # ── Client health scores (churn risk + engagement) ──
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS client_health_scores (
          client_id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          health_score INTEGER NOT NULL DEFAULT 50,
          churn_risk TEXT NOT NULL DEFAULT 'low',
          churn_score INTEGER NOT NULL DEFAULT 0,
          revenue_score INTEGER NOT NULL DEFAULT 0,
          engagement_score INTEGER NOT NULL DEFAULT 0,
          responsiveness_score INTEGER NOT NULL DEFAULT 0,
          last_meeting_ts TEXT,
          last_task_ts TEXT,
          overdue_invoices INTEGER NOT NULL DEFAULT 0,
          active_tasks INTEGER NOT NULL DEFAULT 0,
          notes TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )

    # ── Campaign attribution integrity (campaign-level ROAS summary) ──
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS campaign_integrity (
          utm_campaign TEXT PRIMARY KEY,
          source TEXT,
          total_leads INTEGER NOT NULL DEFAULT 0,
          booked_calls INTEGER NOT NULL DEFAULT 0,
          closed_won INTEGER NOT NULL DEFAULT 0,
          total_revenue_cents INTEGER NOT NULL DEFAULT 0,
          ad_spend_cents INTEGER NOT NULL DEFAULT 0,
          roas REAL NOT NULL DEFAULT 0.0,
          close_rate REAL NOT NULL DEFAULT 0.0,
          integrity_status TEXT NOT NULL DEFAULT 'ok',
          issues_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )

    # ── System boot validation log ──
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS boot_validations (
          id TEXT PRIMARY KEY,
          subsystem TEXT NOT NULL,
          status TEXT NOT NULL,
          details TEXT,
          validated_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_bv_subsystem ON boot_validations(subsystem, validated_at)")

    # ── AgencyOS execution backbone ──

    # Outcomes — strategic goals per client engagement
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS outcomes (
          id TEXT PRIMARY KEY,
          client_id TEXT NOT NULL,
          name TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'Planning',
          target_date TEXT,
          kpi_metric TEXT,
          kpi_target REAL,
          kpi_actual REAL,
          notes TEXT,
          notion_page_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_outcomes_client ON outcomes(client_id)")

    # Projects — scoped units of work under outcomes
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          outcome_id TEXT,
          client_id TEXT NOT NULL,
          name TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'Not Started',
          priority TEXT DEFAULT 'Medium',
          project_type TEXT,
          start_date TEXT,
          due_date TEXT,
          notion_page_id TEXT,
          trello_board_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_projects_client ON projects(client_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_projects_outcome ON projects(outcome_id)")

    # Tasks — atomic deliverables within projects
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          name TEXT NOT NULL,
          assignee TEXT,
          status TEXT NOT NULL DEFAULT 'To Do',
          priority TEXT DEFAULT 'Medium',
          task_type TEXT,
          due_date TEXT,
          estimated_hours REAL,
          trello_card_id TEXT,
          notion_page_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)")

    # Efforts — time entries / resource allocation
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS efforts (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          team_member_id TEXT NOT NULL,
          hours REAL NOT NULL,
          date TEXT NOT NULL,
          billable INTEGER NOT NULL DEFAULT 1,
          notes TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_efforts_task ON efforts(task_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_efforts_member ON efforts(team_member_id)")

    # Expenses — cost tracking, ad spend, operations
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS expenses (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          amount_cents INTEGER NOT NULL DEFAULT 0,
          category TEXT NOT NULL DEFAULT 'Other',
          campaign TEXT,
          vendor TEXT,
          date TEXT NOT NULL,
          recurring INTEGER NOT NULL DEFAULT 0,
          qb_expense_id TEXT,
          notes TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category)")

    # Meetings — meeting log with client relation
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS meetings (
          id TEXT PRIMARY KEY,
          client_id TEXT NOT NULL,
          name TEXT NOT NULL,
          date TEXT NOT NULL,
          meeting_type TEXT,
          attendees TEXT,
          notes TEXT,
          action_items TEXT,
          recording_url TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_meetings_client ON meetings(client_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_meetings_date ON meetings(date)")

    # Contacts — external contacts directory
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS contacts (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT,
          phone TEXT,
          company TEXT,
          role TEXT,
          contact_type TEXT DEFAULT 'Lead',
          ghl_contact_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_contacts_ghl ON contacts(ghl_contact_id)")

    # SOP Library — versioned standard operating procedures
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS sop_library (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          department TEXT NOT NULL,
          owner TEXT,
          version TEXT DEFAULT '1.0',
          status TEXT NOT NULL DEFAULT 'Draft',
          content TEXT,
          notion_page_id TEXT,
          last_updated TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sop_dept ON sop_library(department)")

    # Views Registry — tracks required Notion views for compliance verification
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS views_registry (
          id TEXT PRIMARY KEY,
          database_key TEXT NOT NULL,
          view_name TEXT NOT NULL,
          required INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'unknown',
          last_verified_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS ux_vr_db_view ON views_registry(database_key, view_name)")

    # System settings — workspace manifest version, health thresholds, config
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS system_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          description TEXT,
          updated_at TEXT NOT NULL
        )
        """
    )

    # ── System audit log — CEO-friendly evidence trail ──
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS system_audit_log (
          id TEXT PRIMARY KEY,
          correlation_id TEXT NOT NULL,
          system TEXT NOT NULL,
          action TEXT NOT NULL,
          target TEXT NOT NULL,
          result TEXT NOT NULL,
          details TEXT,
          stop_reason TEXT,
          timestamp TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sal_corr ON system_audit_log(correlation_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sal_system ON system_audit_log(system, timestamp)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sal_ts ON system_audit_log(timestamp)")

    # ── Attribution touchpoints v2 — canonical cross-system attribution object ──
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS attribution_touchpoints_v2 (
          id TEXT PRIMARY KEY,
          ghl_contact_id TEXT,
          manychat_subscriber_id TEXT,
          utm_source TEXT,
          utm_campaign TEXT,
          utm_adset TEXT,
          utm_ad TEXT,
          utm_content TEXT,
          clickfunnels_funnel_id TEXT,
          first_seen_at TEXT,
          last_seen_at TEXT,
          confidence TEXT DEFAULT 'low',
          stripe_customer_id TEXT,
          stripe_payment_intent_id TEXT,
          qb_invoice_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_atv2_ghl ON attribution_touchpoints_v2(ghl_contact_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_atv2_campaign ON attribution_touchpoints_v2(utm_campaign)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_atv2_stripe ON attribution_touchpoints_v2(stripe_customer_id)")

    # ── Backup runs log ──
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS backup_runs (
          id TEXT PRIMARY KEY,
          backup_type TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          file_path TEXT,
          checksum TEXT,
          size_bytes INTEGER,
          details TEXT,
          started_at TEXT NOT NULL,
          completed_at TEXT
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_br_type ON backup_runs(backup_type, started_at)")

    # ── Client portal compliance tracking ──
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS portal_compliance (
          client_id TEXT PRIMARY KEY,
          portal_page_id TEXT,
          compliant INTEGER NOT NULL DEFAULT 0,
          missing_sections TEXT,
          last_checked_at TEXT,
          last_healed_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )

    # ── Audit logs (services/audit.py) — system-wide action trail ──
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS audit_logs (
          id TEXT PRIMARY KEY,
          ts TEXT NOT NULL,
          correlation_id TEXT NOT NULL,
          system TEXT NOT NULL,
          action TEXT NOT NULL,
          target TEXT,
          result TEXT NOT NULL,
          stop_reason TEXT,
          payload_json TEXT,
          notes TEXT
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_audit_logs_ts ON audit_logs(ts)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_audit_logs_corr ON audit_logs(correlation_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_audit_logs_system ON audit_logs(system)")

    # Mirror-tracking columns for Notion audit writer (idempotent ALTERs)
    for col, col_type in [("mirrored_to_notion_at", "TEXT"), ("mirrored_event_key", "TEXT")]:
        try:
            conn.execute(f"ALTER TABLE audit_logs ADD COLUMN {col} {col_type}")
        except Exception:
            pass  # column already exists
    conn.execute("CREATE INDEX IF NOT EXISTS idx_audit_logs_mirrored ON audit_logs(mirrored_to_notion_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_audit_logs_mirror_key ON audit_logs(mirrored_event_key)")

    # ── Snapshots (services/snapshots.py) — backup file tracking ──
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS snapshots (
          id TEXT PRIMARY KEY,
          ts TEXT NOT NULL,
          snapshot_type TEXT NOT NULL,
          scope_key TEXT,
          storage_path TEXT NOT NULL,
          checksum_sha256 TEXT,
          size_bytes INTEGER,
          status TEXT NOT NULL,
          details TEXT
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON snapshots(ts)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_snapshots_type ON snapshots(snapshot_type)")

    # ── Sales objections (marketing/sales_memory.py) — call objection tracking ──
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS sales_objections (
          id TEXT PRIMARY KEY,
          contact_id TEXT NOT NULL,
          objection_category TEXT NOT NULL,
          objection_text TEXT,
          call_outcome TEXT,
          setter_id TEXT,
          campaign TEXT,
          brand TEXT,
          correlation_id TEXT,
          created_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sales_obj_contact ON sales_objections(contact_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sales_obj_category ON sales_objections(objection_category)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sales_obj_campaign ON sales_objections(campaign)")

    # ── Creative registry (marketing/campaign_optimizer.py) — ad creative version tracking ──
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS creative_registry (
          id TEXT PRIMARY KEY,
          creative_name TEXT NOT NULL,
          creative_type TEXT NOT NULL,
          hook_text TEXT,
          campaign TEXT,
          brand TEXT,
          platform TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          launched_at TEXT,
          peak_ctr REAL,
          current_ctr REAL,
          impressions INTEGER DEFAULT 0,
          clicks INTEGER DEFAULT 0,
          conversions INTEGER DEFAULT 0,
          spend_cents INTEGER DEFAULT 0,
          cac_cents INTEGER,
          best_tier TEXT,
          best_close_rate REAL,
          notes TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_creative_campaign ON creative_registry(campaign)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_creative_status ON creative_registry(status)")

    # ── WebOps run history ──
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS webops_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          correlation_id TEXT NOT NULL,
          started_at_utc TEXT NOT NULL,
          finished_at_utc TEXT NOT NULL,
          ok INTEGER NOT NULL,
          summary_json TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_webops_runs_finished ON webops_runs(finished_at_utc)")

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS webops_run_payloads (
          run_id INTEGER PRIMARY KEY,
          payload_json TEXT NOT NULL,
          FOREIGN KEY(run_id) REFERENCES webops_runs(id) ON DELETE CASCADE
        )
        """
    )

    # ── WebOps incidents (site-level issue lifecycle) ──
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS webops_incidents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          site_key TEXT NOT NULL,
          status TEXT NOT NULL,
          severity TEXT NOT NULL,
          title TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          first_seen_utc TEXT NOT NULL,
          last_seen_utc TEXT NOT NULL,
          occurrences INTEGER NOT NULL DEFAULT 1,
          last_details_json TEXT NOT NULL,
          notion_page_id TEXT,
          resolved_at_utc TEXT
        )
        """
    )
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_webops_inc_fp ON webops_incidents(fingerprint)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_webops_inc_site ON webops_incidents(site_key, status)")

    # ── WebOps repair plans (pending human approval for risky fixes) ──
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS webops_repair_plans (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          site_key TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at_utc TEXT NOT NULL,
          created_by TEXT NOT NULL,
          risk_level TEXT NOT NULL,
          plan_json TEXT NOT NULL,
          approved_at_utc TEXT,
          applied_at_utc TEXT
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_webops_repair_plans_site_status "
        "ON webops_repair_plans(site_key, status)"
    )

    # ── WebOps fix action log (audit trail for safe fixes + plan lifecycle) ──
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS webops_fix_actions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          site_key TEXT NOT NULL,
          correlation_id TEXT NOT NULL,
          created_at_utc TEXT NOT NULL,
          action_type TEXT NOT NULL,
          ok INTEGER NOT NULL,
          details_json TEXT NOT NULL
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_webops_fix_actions_site "
        "ON webops_fix_actions(site_key, created_at_utc)"
    )

    # ── Migration 027: Leverage layers ──

    # Setter daily metrics extensions (safe ALTER — ignore if column exists)
    for col_def in [
        "brand TEXT DEFAULT 'fulldigital'",
        "display_name TEXT",
        "appointments_showed INTEGER DEFAULT 0",
        "avg_response_time_minutes REAL DEFAULT 0",
        "current_queue_size INTEGER DEFAULT 0",
    ]:
        try:
            conn.execute(f"ALTER TABLE setter_daily_metrics ADD COLUMN {col_def}")
        except Exception:
            pass  # Column already exists

    # Expansion trigger log
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS expansion_triggers (
          id TEXT PRIMARY KEY,
          contact_key TEXT NOT NULL,
          brand TEXT NOT NULL,
          trigger_type TEXT NOT NULL,
          rule_name TEXT NOT NULL,
          suggested_offer TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TEXT NOT NULL,
          actioned_at TEXT,
          UNIQUE(contact_key, rule_name, status)
        )
        """
    )

    # VSL view events index
    conn.execute(
        """CREATE INDEX IF NOT EXISTS ix_attribution_events_vsl
           ON attribution_events(stage) WHERE stage = 'vsl_view'"""
    )

    # Authority content schedule
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS authority_content_schedule (
          id TEXT PRIMARY KEY,
          brand TEXT NOT NULL,
          week_start TEXT NOT NULL,
          day_of_week INTEGER NOT NULL,
          content_type TEXT NOT NULL,
          topic TEXT,
          angle TEXT,
          cta TEXT,
          status TEXT NOT NULL DEFAULT 'planned',
          created_at TEXT NOT NULL,
          published_at TEXT
        )
        """
    )
    conn.execute(
        """CREATE INDEX IF NOT EXISTS ix_authority_content_week
           ON authority_content_schedule(brand, week_start)"""
    )

    # Meta active budgets — tracks daily budget ceiling per campaign/adset
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS meta_active_budgets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          brand TEXT NOT NULL,
          object_type TEXT NOT NULL,
          object_id TEXT NOT NULL,
          object_name TEXT NOT NULL,
          daily_budget_usd REAL NOT NULL DEFAULT 0,
          is_active INTEGER NOT NULL DEFAULT 1,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """CREATE UNIQUE INDEX IF NOT EXISTS idx_meta_active_budgets_unique
           ON meta_active_budgets(object_type, object_id)"""
    )
    conn.execute(
        """CREATE INDEX IF NOT EXISTS idx_meta_active_budgets_brand_active
           ON meta_active_budgets(brand, is_active)"""
    )

    conn.commit()
