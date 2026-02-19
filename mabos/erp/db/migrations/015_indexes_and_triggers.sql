-- updated_at trigger function
CREATE OR REPLACE FUNCTION erp.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply updated_at trigger to all tables with that column
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'erp' AND column_name = 'updated_at'
  LOOP
    EXECUTE format(
      'CREATE TRIGGER IF NOT EXISTS trg_%s_updated_at BEFORE UPDATE ON erp.%I FOR EACH ROW EXECUTE FUNCTION erp.set_updated_at()',
      tbl, tbl
    );
  END LOOP;
END;
$$;

-- Foreign key indexes
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON erp.invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON erp.payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_ledger_account ON erp.ledger_entries(account_id);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON erp.orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_interactions_contact ON erp.interactions(contact_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON erp.tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_milestones_project ON erp.milestones(project_id);
CREATE INDEX IF NOT EXISTS idx_funnels_campaign ON erp.funnels(campaign_id);
CREATE INDEX IF NOT EXISTS idx_payroll_employee ON erp.payroll(employee_id);
CREATE INDEX IF NOT EXISTS idx_stock_product ON erp.stock_items(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_warehouse ON erp.stock_items(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_supplier_contracts_supplier ON erp.supplier_contracts(supplier_id);
CREATE INDEX IF NOT EXISTS idx_shipments_origin ON erp.shipments(origin_node_id);
CREATE INDEX IF NOT EXISTS idx_shipments_dest ON erp.shipments(dest_node_id);
CREATE INDEX IF NOT EXISTS idx_audits_rule ON erp.audits(rule_id);
CREATE INDEX IF NOT EXISTS idx_violations_rule ON erp.violations(rule_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow ON erp.workflow_runs(workflow_id);

-- Status indexes for common queries
CREATE INDEX IF NOT EXISTS idx_invoices_status ON erp.invoices(status);
CREATE INDEX IF NOT EXISTS idx_orders_status ON erp.orders(status);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON erp.tasks(status);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON erp.campaigns(status);
CREATE INDEX IF NOT EXISTS idx_projects_status ON erp.projects(status);
CREATE INDEX IF NOT EXISTS idx_contracts_status ON erp.contracts(status);
CREATE INDEX IF NOT EXISTS idx_suppliers_status ON erp.suppliers(status);
