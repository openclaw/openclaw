-- 018_accounting_reports.sql
-- Adds budgets table, new accounts, ledger entries, and budget rows for accounting reports

-- ── Budgets table ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS erp.budgets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES erp.accounts(id),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  budgeted_amount NUMERIC(15,2) NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ── New accounts ───────────────────────────────────────────────────
-- Continuing the e0000001 UUID pattern, IDs 7-15
INSERT INTO erp.accounts (id, name, type, currency, balance, parent_id) VALUES
  ('e0000001-0001-4000-8000-000000000007', 'Inventory',           'asset',     'USD', 4200.00, NULL),
  ('e0000001-0001-4000-8000-000000000008', 'Equipment',           'asset',     'USD', 8500.00, NULL),
  ('e0000001-0001-4000-8000-000000000009', 'Accounts Payable',    'liability', 'USD', 3200.00, NULL),
  ('e0000001-0001-4000-8000-000000000010', 'Sales Tax Payable',   'liability', 'USD',  980.00, NULL),
  ('e0000001-0001-4000-8000-000000000011', 'Owner Equity',        'equity',    'USD', 15000.00, NULL),
  ('e0000001-0001-4000-8000-000000000012', 'Retained Earnings',   'equity',    'USD',  5170.00, NULL),
  ('e0000001-0001-4000-8000-000000000013', 'Shipping Expense',    'expense',   'USD',  890.00, NULL),
  ('e0000001-0001-4000-8000-000000000014', 'Software & Tools',    'expense',   'USD',  450.00, NULL),
  ('e0000001-0001-4000-8000-000000000015', 'Contractor Payments', 'expense',   'USD', 2400.00, NULL)
ON CONFLICT (id) DO NOTHING;

-- ── Ledger entries — VividWalls operations Jan-Feb 2026 ────────────
INSERT INTO erp.ledger_entries (id, account_id, debit, credit, description, reference_type, posted_at) VALUES
  -- January 2026 - Revenue & Cash inflows
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000001', 0, 3200.00, 'Custom mural commission - Riverside Cafe',       'invoice',    '2026-01-05 10:00:00Z'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000006', 3200.00, 0, 'Payment received - Riverside Cafe',              'payment',    '2026-01-05 10:00:00Z'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000001', 0, 1800.00, 'Wall art prints - online order batch',           'invoice',    '2026-01-10 14:30:00Z'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000006', 1800.00, 0, 'Stripe payout - online orders',                  'payment',    '2026-01-12 09:00:00Z'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000001', 0, 4500.00, 'Corporate office mural - TechStart Inc',         'invoice',    '2026-01-18 11:00:00Z'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000005', 4500.00, 0, 'Invoice #1042 - TechStart Inc (net 30)',          'invoice',    '2026-01-18 11:00:00Z'),

  -- January 2026 - COGS & Operating expenses
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000002', 1400.00, 0, 'Paint and canvas supplies - Blick Art',           'purchase',   '2026-01-08 08:00:00Z'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000006', 0, 1400.00, 'Payment to Blick Art Materials',                  'payment',    '2026-01-08 08:00:00Z'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000002', 850.00,  0, 'Printing supplies for art prints',                'purchase',   '2026-01-15 10:00:00Z'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000006', 0, 850.00,  'Payment to PrintHub',                            'payment',    '2026-01-15 10:00:00Z'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000004', 1200.00, 0, 'Studio rent - January 2026',                      'expense',    '2026-01-01 00:00:00Z'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000006', 0, 1200.00, 'Rent payment - January',                         'payment',    '2026-01-01 00:00:00Z'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000003', 400.00,  0, 'Instagram ad campaign - January',                 'expense',    '2026-01-07 12:00:00Z'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000006', 0, 400.00,  'Meta Ads payment',                               'payment',    '2026-01-07 12:00:00Z'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000013', 220.00,  0, 'UPS shipping - print orders Jan batch 1',         'expense',    '2026-01-13 09:00:00Z'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000006', 0, 220.00,  'UPS shipping payment',                           'payment',    '2026-01-13 09:00:00Z'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000014', 150.00,  0, 'Adobe Creative Cloud - January',                  'expense',    '2026-01-02 00:00:00Z'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000006', 0, 150.00,  'Adobe CC subscription',                          'payment',    '2026-01-02 00:00:00Z'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000015', 800.00,  0, 'Freelance assistant - mural prep work',           'expense',    '2026-01-20 16:00:00Z'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000006', 0, 800.00,  'Contractor payment - mural assistant',           'payment',    '2026-01-20 16:00:00Z'),

  -- January 2026 - Investing & Financing
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000008', 2500.00, 0, 'Large-format printer purchase',                   'investment', '2026-01-22 14:00:00Z'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000006', 0, 2500.00, 'Equipment purchase - printer',                   'investment', '2026-01-22 14:00:00Z'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000011', 0, 5000.00, 'Owner capital contribution',                     'financing',  '2026-01-03 09:00:00Z'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000006', 5000.00, 0, 'Owner investment deposit',                        'financing',  '2026-01-03 09:00:00Z'),

  -- February 2026 - Revenue & Cash inflows
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000001', 0, 2800.00, 'Accent wall package - HomeStyle Design',         'invoice',    '2026-02-03 10:00:00Z'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000006', 2800.00, 0, 'Payment received - HomeStyle Design',             'payment',    '2026-02-05 09:00:00Z'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000001', 0, 2200.00, 'Art print wholesale - Gallery 54',               'invoice',    '2026-02-10 11:00:00Z'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000005', 2200.00, 0, 'Invoice #1048 - Gallery 54 (net 30)',             'invoice',    '2026-02-10 11:00:00Z'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000006', 4500.00, 0, 'Payment received - TechStart Inc #1042',          'payment',    '2026-02-14 09:00:00Z'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000005', 0, 4500.00, 'AR cleared - TechStart Inc',                     'payment',    '2026-02-14 09:00:00Z'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000001', 0, 3800.00, 'Restaurant mural - Sapori Italian',              'invoice',    '2026-02-20 15:00:00Z'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000006', 3800.00, 0, 'Payment received - Sapori Italian',               'payment',    '2026-02-22 10:00:00Z'),

  -- February 2026 - Expenses
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000002', 1600.00, 0, 'Paint and supplies - February restock',           'purchase',   '2026-02-06 08:00:00Z'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000006', 0, 1600.00, 'Payment to Blick Art Materials',                  'payment',    '2026-02-06 08:00:00Z'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000004', 1200.00, 0, 'Studio rent - February 2026',                     'expense',    '2026-02-01 00:00:00Z'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000006', 0, 1200.00, 'Rent payment - February',                        'payment',    '2026-02-01 00:00:00Z'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000003', 600.00,  0, 'Google Ads + social media - February',            'expense',    '2026-02-08 12:00:00Z'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000006', 0, 600.00,  'Marketing payments - February',                  'payment',    '2026-02-08 12:00:00Z'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000013', 340.00,  0, 'FedEx shipping - Gallery 54 wholesale order',     'expense',    '2026-02-12 09:00:00Z'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000006', 0, 340.00,  'FedEx shipping payment',                         'payment',    '2026-02-12 09:00:00Z'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000014', 150.00,  0, 'Adobe Creative Cloud - February',                 'expense',    '2026-02-02 00:00:00Z'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000006', 0, 150.00,  'Adobe CC subscription',                          'payment',    '2026-02-02 00:00:00Z'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000015', 1200.00, 0, 'Freelance painter - Sapori mural assist',         'expense',    '2026-02-18 16:00:00Z'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000006', 0, 1200.00, 'Contractor payment - painter',                   'payment',    '2026-02-18 16:00:00Z'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000009', 0, 750.00,  'AP payment - Blick Art outstanding balance',     'payment',    '2026-02-25 10:00:00Z'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000006', 0, 750.00,  'AP payment to Blick Art',                        'payment',    '2026-02-25 10:00:00Z'),

  -- February 2026 - Inventory purchase
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000007', 1800.00, 0, 'Canvas and frame inventory restock',              'purchase',   '2026-02-15 11:00:00Z'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000006', 0, 1800.00, 'Inventory purchase payment',                     'purchase',   '2026-02-15 11:00:00Z');

-- ── Budget rows ────────────────────────────────────────────────────
-- February 2026 budgets (7 rows)
INSERT INTO erp.budgets (id, account_id, period_start, period_end, budgeted_amount, notes) VALUES
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000001', '2026-02-01', '2026-02-28', 10000.00, 'Monthly revenue target'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000002', '2026-02-01', '2026-02-28',  2000.00, 'COGS budget'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000003', '2026-02-01', '2026-02-28',   500.00, 'Marketing budget'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000004', '2026-02-01', '2026-02-28',  1300.00, 'Operating expenses budget'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000013', '2026-02-01', '2026-02-28',   300.00, 'Shipping budget'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000014', '2026-02-01', '2026-02-28',   200.00, 'Software & tools budget'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000015', '2026-02-01', '2026-02-28',  1000.00, 'Contractor budget');

-- March 2026 budgets (7 rows)
INSERT INTO erp.budgets (id, account_id, period_start, period_end, budgeted_amount, notes) VALUES
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000001', '2026-03-01', '2026-03-31', 12000.00, 'Monthly revenue target - growth'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000002', '2026-03-01', '2026-03-31',  2200.00, 'COGS budget'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000003', '2026-03-01', '2026-03-31',   700.00, 'Marketing budget - spring push'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000004', '2026-03-01', '2026-03-31',  1300.00, 'Operating expenses budget'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000013', '2026-03-01', '2026-03-31',   350.00, 'Shipping budget'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000014', '2026-03-01', '2026-03-31',   200.00, 'Software & tools budget'),
  (gen_random_uuid(), 'e0000001-0001-4000-8000-000000000015', '2026-03-01', '2026-03-31',  1500.00, 'Contractor budget - mural season');
