/**
 * Tests for per-agent tool filtering based on ROLE_TOOL_SCOPE.
 * Verifies that agents only see role-appropriate tools.
 */

import { describe, it, assert } from "vitest";
import {
  ROLE_TOOL_SCOPE,
  SHARED_TOOL_PATTERNS,
  getToolsForRole,
  isToolAllowedForRole,
} from "../src/tools/tool-filter.js";

// Simulate all registered tool names
const ALL_TOOLS = [
  // BDI (shared)
  "belief_get",
  "belief_update",
  "goal_create",
  "goal_evaluate",
  "intention_commit",
  "intention_update",
  "intention_reconsider",
  "desire_create",
  "desire_evaluate",
  "desire_drop",
  "bdi_cycle",
  "plan_generate",
  "plan_execute_step",
  "skill_inventory",
  "action_log",
  "goal_progress_update",
  // Reasoning (shared)
  "reason",
  "knowledge_explain",
  "fact_assert",
  "fact_query",
  "infer_forward",
  "infer_backward",
  "infer_abductive",
  "htn_decompose",
  // Memory (shared)
  "memory_store_item",
  "memory_recall",
  "memory_consolidate",
  "memory_status",
  "memory_checkpoint",
  "memory_observe",
  // Communication (shared)
  "agent_message",
  "agent_spawn",
  "contract_net_initiate",
  "contract_net_award",
  "decision_request",
  "handoff",
  "notify_stakeholder",
  "request_approval",
  // Cognitive (shared)
  "cognitive_demand",
  "cognitive_route",
  "cognitive_status",
  // CBR (shared)
  "cbr_retrieve",
  "cbr_store",
  // Business ops
  "metrics_record",
  "metrics_dashboard",
  "report_generate",
  "report_schedule",
  "financial_forecast",
  "financial_budget",
  "financial_scenario",
  "financial_reconcile",
  "financial_variance",
  // Marketing
  "marketing_campaign",
  "marketing_analytics",
  "content_generate",
  "ad_create",
  "ad_optimize",
  "email_campaign",
  "email_template",
  "seo_audit",
  "audience_segment",
  "crm_update",
  "lead_score",
  "marketing_attribution",
  "marketing_mix",
  // CTO
  "cloudflare_deploy",
  "integration_setup",
  "integration_list",
  "integration_sync",
  "integration_call",
  "typedb_status",
  "typedb_query",
  "webhook_process",
  "setup_wizard_start",
  "setup_channel",
  "cicd_pipeline",
  "cicd_deploy",
  "security_scan",
  "apm_dashboard",
  // COO
  "workflow_create",
  "workflow_execute",
  "bpmn_migrate",
  "work_package_create",
  "work_package_assign",
  "work_package_list",
  "supply_chain_status",
  "vendor_score",
  "sla_track",
  "capacity_plan",
  "inventory_status",
  // Rules
  "rule_create",
  "rule_list",
  "rule_toggle",
  "constraint_check",
  "policy_eval",
  // Stakeholder
  "stakeholder_report",
  "stakeholder_approval",
  // Ontology
  "ontology_query",
  "ontology_update",
  // Ecommerce
  "shopify_product",
  "shopify_order",
  "order_fulfill",
  "inventory_check",
];

describe("tool-filter", () => {
  describe("ROLE_TOOL_SCOPE", () => {
    it("has entries for all C-suite roles", () => {
      assert.ok(ROLE_TOOL_SCOPE.ceo);
      assert.ok(ROLE_TOOL_SCOPE.cfo);
      assert.ok(ROLE_TOOL_SCOPE.cmo);
      assert.ok(ROLE_TOOL_SCOPE.coo);
      assert.ok(ROLE_TOOL_SCOPE.cto);
    });

    it("has entries for support roles", () => {
      assert.ok(ROLE_TOOL_SCOPE.legal);
      assert.ok(ROLE_TOOL_SCOPE.hr);
      assert.ok(ROLE_TOOL_SCOPE.strategy);
      assert.ok(ROLE_TOOL_SCOPE.knowledge);
      assert.ok(ROLE_TOOL_SCOPE.ecommerce);
    });
  });

  describe("SHARED_TOOL_PATTERNS", () => {
    it("includes BDI, communication, memory, cognitive patterns", () => {
      assert.ok(SHARED_TOOL_PATTERNS.length > 0);
      // Shared tools should match common agent tools
      const sharedNames = [
        "belief_get",
        "goal_create",
        "agent_message",
        "memory_recall",
        "cognitive_route",
        "bdi_cycle",
        "cbr_retrieve",
      ];
      for (const name of sharedNames) {
        assert.ok(
          isToolAllowedForRole("cfo", name),
          `shared tool '${name}' should be allowed for any role`,
        );
      }
    });
  });

  describe("isToolAllowedForRole", () => {
    it("allows shared tools for any role", () => {
      assert.ok(isToolAllowedForRole("cfo", "belief_get"));
      assert.ok(isToolAllowedForRole("cmo", "agent_message"));
      assert.ok(isToolAllowedForRole("cto", "memory_recall"));
      assert.ok(isToolAllowedForRole("coo", "cognitive_route"));
    });

    it("allows role-specific tools", () => {
      assert.ok(isToolAllowedForRole("cfo", "financial_forecast"));
      assert.ok(isToolAllowedForRole("cfo", "metrics_record"));
      assert.ok(isToolAllowedForRole("cmo", "marketing_campaign"));
      assert.ok(isToolAllowedForRole("cmo", "email_campaign"));
      assert.ok(isToolAllowedForRole("cto", "cloudflare_deploy"));
      assert.ok(isToolAllowedForRole("cto", "cicd_pipeline"));
      assert.ok(isToolAllowedForRole("coo", "workflow_create"));
      assert.ok(isToolAllowedForRole("coo", "supply_chain_status"));
    });

    it("blocks cross-domain tools", () => {
      // CFO should not have marketing tools
      assert.ok(!isToolAllowedForRole("cfo", "marketing_campaign"));
      assert.ok(!isToolAllowedForRole("cfo", "ad_create"));
      // CMO should not have financial tools
      assert.ok(!isToolAllowedForRole("cmo", "financial_forecast"));
      // CTO should not have workflow tools
      assert.ok(!isToolAllowedForRole("cto", "workflow_create"));
      // COO should not have marketing tools
      assert.ok(!isToolAllowedForRole("coo", "marketing_campaign"));
    });

    it("allows all tools for unknown roles", () => {
      assert.ok(isToolAllowedForRole("unknown-role", "marketing_campaign"));
      assert.ok(isToolAllowedForRole("unknown-role", "financial_forecast"));
    });

    it("CEO gets broad access", () => {
      assert.ok(isToolAllowedForRole("ceo", "decision_request"));
      assert.ok(isToolAllowedForRole("ceo", "metrics_dashboard"));
      assert.ok(isToolAllowedForRole("ceo", "report_generate"));
      assert.ok(isToolAllowedForRole("ceo", "stakeholder_report"));
    });
  });

  describe("getToolsForRole", () => {
    it("returns only allowed tools for a role", () => {
      const cfoTools = getToolsForRole("cfo", ALL_TOOLS);
      // Should include shared + CFO-specific
      assert.ok(cfoTools.includes("belief_get"));
      assert.ok(cfoTools.includes("financial_forecast"));
      assert.ok(cfoTools.includes("metrics_record"));
      // Should NOT include other roles' tools
      assert.ok(!cfoTools.includes("marketing_campaign"));
      assert.ok(!cfoTools.includes("cloudflare_deploy"));
    });

    it("returns all tools for unknown role", () => {
      const tools = getToolsForRole("unknown", ALL_TOOLS);
      assert.equal(tools.length, ALL_TOOLS.length);
    });

    it("COO gets supply chain and workflow tools", () => {
      const cooTools = getToolsForRole("coo", ALL_TOOLS);
      assert.ok(cooTools.includes("workflow_create"));
      assert.ok(cooTools.includes("supply_chain_status"));
      assert.ok(cooTools.includes("vendor_score"));
      assert.ok(cooTools.includes("sla_track"));
      assert.ok(cooTools.includes("capacity_plan"));
      // COO also gets report and integration tools
      assert.ok(cooTools.includes("report_generate"));
      assert.ok(cooTools.includes("integration_setup"));
    });

    it("CTO gets CI/CD and security tools", () => {
      const ctoTools = getToolsForRole("cto", ALL_TOOLS);
      assert.ok(ctoTools.includes("cicd_pipeline"));
      assert.ok(ctoTools.includes("cicd_deploy"));
      assert.ok(ctoTools.includes("security_scan"));
      assert.ok(ctoTools.includes("apm_dashboard"));
      assert.ok(ctoTools.includes("cloudflare_deploy"));
    });

    it("CMO gets attribution and lead tools", () => {
      const cmoTools = getToolsForRole("cmo", ALL_TOOLS);
      assert.ok(cmoTools.includes("marketing_attribution"));
      assert.ok(cmoTools.includes("marketing_mix"));
      assert.ok(cmoTools.includes("lead_score"));
      assert.ok(cmoTools.includes("audience_segment"));
    });
  });
});
