-- Ledger revenue table: normalized Stripe payment records.
-- Stores net revenue (gross minus refunds) per payment_id.
-- Close counts only where net_usd > 0 (refunds excluded automatically).
--
-- Ingestion rules:
--   payment_succeeded / invoice.paid:
--     INSERT gross_usd=amount, refund_usd=0, net_usd=amount
--   charge.refunded / charge.refund.updated:
--     UPDATE refund_usd += refund_amount, net_usd = gross_usd - refund_usd

CREATE TABLE IF NOT EXISTS ledger_revenue (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  brand     TEXT    NOT NULL,
  combo_id  TEXT    NOT NULL,
  payment_id TEXT   NOT NULL,
  event_ts  TEXT    NOT NULL,
  gross_usd REAL    NOT NULL DEFAULT 0,
  refund_usd REAL   NOT NULL DEFAULT 0,
  net_usd   REAL    NOT NULL DEFAULT 0,
  currency  TEXT    NOT NULL DEFAULT 'USD'
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_revenue_payment
  ON ledger_revenue(payment_id);

CREATE INDEX IF NOT EXISTS idx_ledger_revenue_combo_ts
  ON ledger_revenue(brand, combo_id, event_ts);
