-- Combo metrics materialized views (v1: normal VIEWs, not truly materialized).
-- Later can be converted to tables refreshed by a scheduled job.
--
-- SQLite-safe: uses union-keys pattern (no FULL OUTER JOIN).
-- Assumes JSON1 extension enabled. If not, add value_usd / quality_score
-- columns to attribution_events directly and drop v_attribution_event_values.
--
-- Expected base tables:
--   attribution_events  (event_ts, brand, combo_id, event_name, payload_json)
--   ledger_revenue      (event_ts, brand, combo_id, net_usd)
--   angle_fatigue_scores (as_of_ts, brand, combo_id, fatigue_score)
--
-- Full Digital definitions (strict):
--   calls_observed = calls_showed (not booked)
--   close_rate = Stripe paid only, refunds excluded (net_usd > 0)
--   close_rate denominator = calls_showed

-- ─────────────────────────────────────────────────────────────
-- A4) Fatigue scores table (create now so views never fail)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS angle_fatigue_scores (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  as_of_ts      TEXT    NOT NULL,
  brand         TEXT    NOT NULL,
  combo_id      TEXT    NOT NULL,
  fatigue_score REAL    NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_fatigue_combo_ts
  ON angle_fatigue_scores(brand, combo_id, as_of_ts);


-- ─────────────────────────────────────────────────────────────
-- A1) Helper VIEW: extract numeric values from payload_json
-- ─────────────────────────────────────────────────────────────

CREATE VIEW IF NOT EXISTS v_attribution_event_values AS
SELECT
  event_ts,
  brand,
  combo_id,
  event_name,
  CAST(json_extract(payload_json, '$.value_usd') AS REAL) AS value_usd,
  CAST(json_extract(payload_json, '$.quality') AS REAL)   AS quality_score
FROM attribution_events;


-- ─────────────────────────────────────────────────────────────
-- A2) LAST 24H
-- ─────────────────────────────────────────────────────────────

CREATE VIEW IF NOT EXISTS mv_combo_metrics_last_24h AS
WITH
window AS (
  SELECT datetime('now', '-24 hours') AS start_ts,
         datetime('now')              AS end_ts
),

spend AS (
  SELECT brand, combo_id,
         SUM(COALESCE(value_usd, 0)) AS spend_usd
  FROM v_attribution_event_values e, window w
  WHERE e.event_name = 'meta_spend'
    AND e.event_ts >= w.start_ts AND e.event_ts < w.end_ts
  GROUP BY brand, combo_id
),

calls AS (
  SELECT brand, combo_id,
         COUNT(*) AS calls_showed
  FROM attribution_events e, window w
  WHERE e.event_name = 'call_showed'
    AND e.event_ts >= w.start_ts AND e.event_ts < w.end_ts
  GROUP BY brand, combo_id
),

pipeline AS (
  SELECT brand, combo_id,
         AVG(COALESCE(quality_score, 0)) AS pipeline_quality
  FROM v_attribution_event_values e, window w
  WHERE e.event_name = 'pipeline_quality'
    AND e.event_ts >= w.start_ts AND e.event_ts < w.end_ts
  GROUP BY brand, combo_id
),

conversions AS (
  -- Customize event_name list per brand as needed.
  -- CUTMV: trial_paid, subscription_paid, purchase
  -- Full Digital: stripe_paid or application_submit
  SELECT brand, combo_id,
         COUNT(*) AS conversions
  FROM attribution_events e, window w
  WHERE e.event_name IN ('trial_paid', 'purchase', 'subscription_paid')
    AND e.event_ts >= w.start_ts AND e.event_ts < w.end_ts
  GROUP BY brand, combo_id
),

revenue AS (
  -- Stripe paid only, refunds excluded (net_usd > 0)
  SELECT brand, combo_id,
         SUM(CASE WHEN net_usd > 0 THEN net_usd ELSE 0 END) AS revenue_usd,
         SUM(CASE WHEN net_usd > 0 THEN 1 ELSE 0 END)       AS net_paid_count
  FROM ledger_revenue r, window w
  WHERE r.event_ts >= w.start_ts AND r.event_ts < w.end_ts
  GROUP BY brand, combo_id
),

fatigue AS (
  SELECT brand, combo_id,
         MAX(COALESCE(fatigue_score, 0)) AS fatigue_score
  FROM angle_fatigue_scores s, window w
  WHERE s.as_of_ts >= w.start_ts AND s.as_of_ts < w.end_ts
  GROUP BY brand, combo_id
),

keys AS (
  SELECT brand, combo_id FROM spend
  UNION SELECT brand, combo_id FROM calls
  UNION SELECT brand, combo_id FROM pipeline
  UNION SELECT brand, combo_id FROM conversions
  UNION SELECT brand, combo_id FROM revenue
  UNION SELECT brand, combo_id FROM fatigue
)

SELECT
  k.brand,
  k.combo_id,

  COALESCE(spend.spend_usd, 0) AS spend_usd,
  COALESCE(conversions.conversions, 0) AS conversions,

  CASE
    WHEN COALESCE(conversions.conversions, 0) > 0
      THEN COALESCE(spend.spend_usd, 0) / conversions.conversions
    ELSE 0
  END AS cpa,

  CASE
    WHEN COALESCE(spend.spend_usd, 0) > 0
      THEN COALESCE(revenue.revenue_usd, 0) / spend.spend_usd
    ELSE 0
  END AS roas,

  COALESCE(fatigue.fatigue_score, 0) AS fatigue_score,

  COALESCE(calls.calls_showed, 0) AS calls_showed,
  COALESCE(pipeline.pipeline_quality, 0) AS pipeline_quality,

  -- Strict close rate: Stripe net-paid-only / calls_showed
  CASE
    WHEN COALESCE(calls.calls_showed, 0) > 0
      THEN COALESCE(revenue.net_paid_count, 0) * 1.0 / calls.calls_showed
    ELSE 0
  END AS close_rate

FROM keys k
LEFT JOIN spend       ON spend.brand = k.brand AND spend.combo_id = k.combo_id
LEFT JOIN conversions ON conversions.brand = k.brand AND conversions.combo_id = k.combo_id
LEFT JOIN revenue     ON revenue.brand = k.brand AND revenue.combo_id = k.combo_id
LEFT JOIN calls       ON calls.brand = k.brand AND calls.combo_id = k.combo_id
LEFT JOIN pipeline    ON pipeline.brand = k.brand AND pipeline.combo_id = k.combo_id
LEFT JOIN fatigue     ON fatigue.brand = k.brand AND fatigue.combo_id = k.combo_id;


-- ─────────────────────────────────────────────────────────────
-- A3a) PREV 2D — baseline window: now-72h to now-24h (48 hours)
-- ─────────────────────────────────────────────────────────────

CREATE VIEW IF NOT EXISTS mv_combo_metrics_prev_2d AS
WITH
window AS (
  SELECT datetime('now', '-72 hours') AS start_ts,
         datetime('now', '-24 hours') AS end_ts
),

spend AS (
  SELECT brand, combo_id,
         SUM(COALESCE(value_usd, 0)) AS spend_usd
  FROM v_attribution_event_values e, window w
  WHERE e.event_name = 'meta_spend'
    AND e.event_ts >= w.start_ts AND e.event_ts < w.end_ts
  GROUP BY brand, combo_id
),

calls AS (
  SELECT brand, combo_id,
         COUNT(*) AS calls_showed
  FROM attribution_events e, window w
  WHERE e.event_name = 'call_showed'
    AND e.event_ts >= w.start_ts AND e.event_ts < w.end_ts
  GROUP BY brand, combo_id
),

pipeline AS (
  SELECT brand, combo_id,
         AVG(COALESCE(quality_score, 0)) AS pipeline_quality
  FROM v_attribution_event_values e, window w
  WHERE e.event_name = 'pipeline_quality'
    AND e.event_ts >= w.start_ts AND e.event_ts < w.end_ts
  GROUP BY brand, combo_id
),

conversions AS (
  SELECT brand, combo_id,
         COUNT(*) AS conversions
  FROM attribution_events e, window w
  WHERE e.event_name IN ('trial_paid', 'purchase', 'subscription_paid')
    AND e.event_ts >= w.start_ts AND e.event_ts < w.end_ts
  GROUP BY brand, combo_id
),

revenue AS (
  SELECT brand, combo_id,
         SUM(CASE WHEN net_usd > 0 THEN net_usd ELSE 0 END) AS revenue_usd,
         SUM(CASE WHEN net_usd > 0 THEN 1 ELSE 0 END)       AS net_paid_count
  FROM ledger_revenue r, window w
  WHERE r.event_ts >= w.start_ts AND r.event_ts < w.end_ts
  GROUP BY brand, combo_id
),

fatigue AS (
  SELECT brand, combo_id,
         MAX(COALESCE(fatigue_score, 0)) AS fatigue_score
  FROM angle_fatigue_scores s, window w
  WHERE s.as_of_ts >= w.start_ts AND s.as_of_ts < w.end_ts
  GROUP BY brand, combo_id
),

keys AS (
  SELECT brand, combo_id FROM spend
  UNION SELECT brand, combo_id FROM calls
  UNION SELECT brand, combo_id FROM pipeline
  UNION SELECT brand, combo_id FROM conversions
  UNION SELECT brand, combo_id FROM revenue
  UNION SELECT brand, combo_id FROM fatigue
)

SELECT
  k.brand, k.combo_id,
  COALESCE(spend.spend_usd, 0) AS spend_usd,
  COALESCE(conversions.conversions, 0) AS conversions,
  CASE WHEN COALESCE(conversions.conversions, 0) > 0
       THEN COALESCE(spend.spend_usd, 0) / conversions.conversions ELSE 0 END AS cpa,
  CASE WHEN COALESCE(spend.spend_usd, 0) > 0
       THEN COALESCE(revenue.revenue_usd, 0) / spend.spend_usd ELSE 0 END AS roas,
  COALESCE(fatigue.fatigue_score, 0) AS fatigue_score,
  COALESCE(calls.calls_showed, 0) AS calls_showed,
  COALESCE(pipeline.pipeline_quality, 0) AS pipeline_quality,
  CASE WHEN COALESCE(calls.calls_showed, 0) > 0
       THEN COALESCE(revenue.net_paid_count, 0) * 1.0 / calls.calls_showed ELSE 0 END AS close_rate
FROM keys k
LEFT JOIN spend       ON spend.brand = k.brand AND spend.combo_id = k.combo_id
LEFT JOIN conversions ON conversions.brand = k.brand AND conversions.combo_id = k.combo_id
LEFT JOIN revenue     ON revenue.brand = k.brand AND revenue.combo_id = k.combo_id
LEFT JOIN calls       ON calls.brand = k.brand AND calls.combo_id = k.combo_id
LEFT JOIN pipeline    ON pipeline.brand = k.brand AND pipeline.combo_id = k.combo_id
LEFT JOIN fatigue     ON fatigue.brand = k.brand AND fatigue.combo_id = k.combo_id;


-- ─────────────────────────────────────────────────────────────
-- A3b) PREV 3D — baseline window: now-96h to now-24h (72 hours)
-- ─────────────────────────────────────────────────────────────

CREATE VIEW IF NOT EXISTS mv_combo_metrics_prev_3d AS
WITH
window AS (
  SELECT datetime('now', '-96 hours') AS start_ts,
         datetime('now', '-24 hours') AS end_ts
),

spend AS (
  SELECT brand, combo_id,
         SUM(COALESCE(value_usd, 0)) AS spend_usd
  FROM v_attribution_event_values e, window w
  WHERE e.event_name = 'meta_spend'
    AND e.event_ts >= w.start_ts AND e.event_ts < w.end_ts
  GROUP BY brand, combo_id
),

calls AS (
  SELECT brand, combo_id,
         COUNT(*) AS calls_showed
  FROM attribution_events e, window w
  WHERE e.event_name = 'call_showed'
    AND e.event_ts >= w.start_ts AND e.event_ts < w.end_ts
  GROUP BY brand, combo_id
),

pipeline AS (
  SELECT brand, combo_id,
         AVG(COALESCE(quality_score, 0)) AS pipeline_quality
  FROM v_attribution_event_values e, window w
  WHERE e.event_name = 'pipeline_quality'
    AND e.event_ts >= w.start_ts AND e.event_ts < w.end_ts
  GROUP BY brand, combo_id
),

conversions AS (
  SELECT brand, combo_id,
         COUNT(*) AS conversions
  FROM attribution_events e, window w
  WHERE e.event_name IN ('trial_paid', 'purchase', 'subscription_paid')
    AND e.event_ts >= w.start_ts AND e.event_ts < w.end_ts
  GROUP BY brand, combo_id
),

revenue AS (
  SELECT brand, combo_id,
         SUM(CASE WHEN net_usd > 0 THEN net_usd ELSE 0 END) AS revenue_usd,
         SUM(CASE WHEN net_usd > 0 THEN 1 ELSE 0 END)       AS net_paid_count
  FROM ledger_revenue r, window w
  WHERE r.event_ts >= w.start_ts AND r.event_ts < w.end_ts
  GROUP BY brand, combo_id
),

fatigue AS (
  SELECT brand, combo_id,
         MAX(COALESCE(fatigue_score, 0)) AS fatigue_score
  FROM angle_fatigue_scores s, window w
  WHERE s.as_of_ts >= w.start_ts AND s.as_of_ts < w.end_ts
  GROUP BY brand, combo_id
),

keys AS (
  SELECT brand, combo_id FROM spend
  UNION SELECT brand, combo_id FROM calls
  UNION SELECT brand, combo_id FROM pipeline
  UNION SELECT brand, combo_id FROM conversions
  UNION SELECT brand, combo_id FROM revenue
  UNION SELECT brand, combo_id FROM fatigue
)

SELECT
  k.brand, k.combo_id,
  COALESCE(spend.spend_usd, 0) AS spend_usd,
  COALESCE(conversions.conversions, 0) AS conversions,
  CASE WHEN COALESCE(conversions.conversions, 0) > 0
       THEN COALESCE(spend.spend_usd, 0) / conversions.conversions ELSE 0 END AS cpa,
  CASE WHEN COALESCE(spend.spend_usd, 0) > 0
       THEN COALESCE(revenue.revenue_usd, 0) / spend.spend_usd ELSE 0 END AS roas,
  COALESCE(fatigue.fatigue_score, 0) AS fatigue_score,
  COALESCE(calls.calls_showed, 0) AS calls_showed,
  COALESCE(pipeline.pipeline_quality, 0) AS pipeline_quality,
  CASE WHEN COALESCE(calls.calls_showed, 0) > 0
       THEN COALESCE(revenue.net_paid_count, 0) * 1.0 / calls.calls_showed ELSE 0 END AS close_rate
FROM keys k
LEFT JOIN spend       ON spend.brand = k.brand AND spend.combo_id = k.combo_id
LEFT JOIN conversions ON conversions.brand = k.brand AND conversions.combo_id = k.combo_id
LEFT JOIN revenue     ON revenue.brand = k.brand AND revenue.combo_id = k.combo_id
LEFT JOIN calls       ON calls.brand = k.brand AND calls.combo_id = k.combo_id
LEFT JOIN pipeline    ON pipeline.brand = k.brand AND pipeline.combo_id = k.combo_id
LEFT JOIN fatigue     ON fatigue.brand = k.brand AND fatigue.combo_id = k.combo_id;
