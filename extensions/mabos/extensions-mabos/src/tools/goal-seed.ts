/**
 * VividWalls Business Goal Seeding — Populates the mabos knowledge graph
 *
 * Programmatically inserts agents, desires, goals (3-tier TOGAF hierarchy),
 * beliefs, and Tropos dependency relations derived from VividWalls' BRD,
 * 5-year financial model, and Business Model Canvas.
 *
 * Goal structure follows TOGAF Driver/Goal/Objective catalog:
 *   Strategic (5-year vision) → Tactical (Year 1-2 milestones) → Operational (monthly/weekly)
 *
 * All entities are scoped via agent_owns to their responsible C-suite agent.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { getTypeDBClient } from "../knowledge/typedb-client.js";
import {
  GoalStoreQueries,
  DesireStoreQueries,
  BeliefStoreQueries,
  DecisionStoreQueries,
  WorkflowStoreQueries,
  TaskStoreQueries,
  IntentionStoreQueries,
} from "../knowledge/typedb-queries.js";
import { textResult } from "./common.js";

// ── Seed Data ───────────────────────────────────────────────────────────

const AGENTS = [
  // Core agents
  { id: "vw-ceo", name: "CEO Agent" },
  { id: "vw-cfo", name: "CFO Agent" },
  { id: "vw-cmo", name: "CMO Agent" },
  { id: "vw-cto", name: "CTO Agent" },
  { id: "vw-coo", name: "COO Agent" },
  { id: "vw-hr", name: "HR Agent" },
  { id: "vw-legal", name: "Legal Agent" },
  { id: "vw-knowledge", name: "Knowledge Agent" },
  { id: "vw-strategy", name: "Strategy Agent" },
  // Domain agents
  { id: "vw-inventory-mgr", name: "Inventory Manager" },
  { id: "vw-fulfillment-mgr", name: "Fulfillment Manager" },
  { id: "vw-product-mgr", name: "Product Manager" },
  { id: "vw-marketing-director", name: "Marketing Director" },
  { id: "vw-sales-director", name: "Sales Director" },
  { id: "vw-compliance-director", name: "Compliance Director" },
  { id: "vw-creative-director", name: "Creative Director" },
  { id: "vw-cs-director", name: "Customer Service Director" },
];

interface DesireSeed {
  id: string;
  agentId: string;
  name: string;
  description: string;
  priority: number;
  importance: number;
  urgency: number;
  alignment: number;
  category: string;
}

const DESIRES: DesireSeed[] = [
  // CEO
  {
    id: "D-CEO-001",
    agentId: "vw-ceo",
    name: "Business Viability",
    description: "Ensure VividWalls survives and thrives as a premium art e-commerce business",
    priority: 0.95,
    importance: 1.0,
    urgency: 0.8,
    alignment: 1.0,
    category: "terminal",
  },
  {
    id: "D-CEO-002",
    agentId: "vw-ceo",
    name: "Strategic Coherence",
    description: "All departments and agents work toward aligned VividWalls objectives",
    priority: 0.87,
    importance: 0.9,
    urgency: 0.7,
    alignment: 1.0,
    category: "terminal",
  },
  {
    id: "D-CEO-003",
    agentId: "vw-ceo",
    name: "Innovation & Growth",
    description: "Continuously improve art offerings and expand to new markets",
    priority: 0.72,
    importance: 0.8,
    urgency: 0.5,
    alignment: 0.9,
    category: "terminal",
  },
  // CFO
  {
    id: "D-CFO-001",
    agentId: "vw-cfo",
    name: "Financial Solvency",
    description: "Ensure VividWalls always has enough cash to operate",
    priority: 0.94,
    importance: 1.0,
    urgency: 0.8,
    alignment: 1.0,
    category: "terminal",
  },
  {
    id: "D-CFO-002",
    agentId: "vw-cfo",
    name: "Revenue Growth",
    description: "Drive revenue from $2.3M to $13.7M over 5 years",
    priority: 0.88,
    importance: 0.9,
    urgency: 0.7,
    alignment: 0.95,
    category: "terminal",
  },
  {
    id: "D-CFO-003",
    agentId: "vw-cfo",
    name: "Cost Optimization",
    description: "Reduce COGS from 60% to 48% through scale and efficiency",
    priority: 0.82,
    importance: 0.8,
    urgency: 0.6,
    alignment: 0.9,
    category: "instrumental",
  },
  // CMO
  {
    id: "D-CMO-001",
    agentId: "vw-cmo",
    name: "Brand Awareness",
    description: "Establish VividWalls as the premium abstract art destination",
    priority: 0.9,
    importance: 0.9,
    urgency: 0.8,
    alignment: 0.95,
    category: "terminal",
  },
  {
    id: "D-CMO-002",
    agentId: "vw-cmo",
    name: "Customer Acquisition",
    description: "Grow customer base across consumer, designer, and commercial segments",
    priority: 0.88,
    importance: 0.9,
    urgency: 0.8,
    alignment: 0.9,
    category: "terminal",
  },
  {
    id: "D-CMO-003",
    agentId: "vw-cmo",
    name: "Limited Edition Success",
    description: "Drive premium pricing and FOMO through scarcity marketing",
    priority: 0.85,
    importance: 0.85,
    urgency: 0.7,
    alignment: 0.9,
    category: "terminal",
  },
  // CTO
  {
    id: "D-CTO-001",
    agentId: "vw-cto",
    name: "Platform Reliability",
    description: "Maintain 99.9% uptime for vividwalls.co e-commerce platform",
    priority: 0.92,
    importance: 0.95,
    urgency: 0.8,
    alignment: 0.9,
    category: "terminal",
  },
  {
    id: "D-CTO-002",
    agentId: "vw-cto",
    name: "AI/ML Excellence",
    description: "Leverage AI for operations efficiency, personalization, and art generation",
    priority: 0.85,
    importance: 0.85,
    urgency: 0.6,
    alignment: 0.9,
    category: "terminal",
  },
  {
    id: "D-CTO-003",
    agentId: "vw-cto",
    name: "AR Innovation",
    description: "Develop augmented reality preview features for wall art visualization",
    priority: 0.78,
    importance: 0.75,
    urgency: 0.5,
    alignment: 0.85,
    category: "instrumental",
  },
  // COO
  {
    id: "D-COO-001",
    agentId: "vw-coo",
    name: "Operational Efficiency",
    description: "Streamline order fulfillment, printing, and shipping processes",
    priority: 0.91,
    importance: 0.9,
    urgency: 0.8,
    alignment: 0.9,
    category: "terminal",
  },
  {
    id: "D-COO-002",
    agentId: "vw-coo",
    name: "Supply Chain Reliability",
    description: "Ensure consistent supply of premium canvas, inks, and framing materials",
    priority: 0.86,
    importance: 0.85,
    urgency: 0.7,
    alignment: 0.85,
    category: "terminal",
  },
  {
    id: "D-COO-003",
    agentId: "vw-coo",
    name: "Quality Control",
    description: "Maintain 95%+ print quality score and <5% return rate",
    priority: 0.88,
    importance: 0.9,
    urgency: 0.75,
    alignment: 0.9,
    category: "terminal",
  },
  // HR
  {
    id: "D-HR-001",
    agentId: "vw-hr",
    name: "Talent Acquisition",
    description: "Recruit skilled team for art curation, tech, and operations",
    priority: 0.8,
    importance: 0.8,
    urgency: 0.6,
    alignment: 0.85,
    category: "terminal",
  },
  // Legal
  {
    id: "D-LEGAL-001",
    agentId: "vw-legal",
    name: "IP Protection",
    description: "Protect art collections, brand, and limited edition authenticity",
    priority: 0.82,
    importance: 0.85,
    urgency: 0.6,
    alignment: 0.9,
    category: "terminal",
  },
  // Strategy
  {
    id: "D-STRAT-001",
    agentId: "vw-strategy",
    name: "Competitive Positioning",
    description: "Maintain premium positioning against AI-driven art platforms",
    priority: 0.85,
    importance: 0.85,
    urgency: 0.65,
    alignment: 0.95,
    category: "terminal",
  },
];

interface GoalSeed {
  id: string;
  agentId: string;
  name: string;
  description: string;
  hierarchy_level: string;
  priority: number;
  success_criteria?: string;
  deadline?: string;
  parent_goal_id?: string;
  desire_ids: string[]; // desires that motivate this goal
  goal_type?: string; // BDI goal type: achieve, maintain, cease, avoid, query
}

const GOALS: GoalSeed[] = [
  // ── Strategic Goals (5-year) ──────────────────────────────────────
  {
    id: "G-S001",
    agentId: "vw-cfo",
    name: "Reach $13.7M Revenue by Year 5",
    description:
      "Grow VividWalls from $2.3M to $13.7M annual revenue across consumer, designer, and commercial segments",
    hierarchy_level: "strategic",
    priority: 0.95,
    success_criteria: "Annual revenue >= $13.7M",
    deadline: "2030-12-31",
    desire_ids: ["D-CFO-002"],
    goal_type: "achieve",
  },
  {
    id: "G-S002",
    agentId: "vw-cfo",
    name: "Achieve 26% EBITDA Margin by Year 5",
    description:
      "Improve profitability from -12% to 26% EBITDA margin through scale and cost optimization",
    hierarchy_level: "strategic",
    priority: 0.9,
    success_criteria: "EBITDA margin >= 26%",
    deadline: "2030-12-31",
    desire_ids: ["D-CFO-001", "D-CFO-003"],
    goal_type: "achieve",
  },
  {
    id: "G-S003",
    agentId: "vw-cmo",
    name: "Grow to 18,767 Orders/Year by Year 5",
    description: "Scale order volume from 3,833 to 18,767 orders annually",
    hierarchy_level: "strategic",
    priority: 0.88,
    success_criteria: "Annual orders >= 18,767",
    deadline: "2030-12-31",
    desire_ids: ["D-CMO-002"],
    goal_type: "achieve",
  },
  {
    id: "G-S004",
    agentId: "vw-cmo",
    name: "Reach $730 Average Order Value by Year 5",
    description: "Increase AOV from $600 to $730 through upselling and premium products",
    hierarchy_level: "strategic",
    priority: 0.85,
    success_criteria: "AOV >= $730",
    deadline: "2030-12-31",
    desire_ids: ["D-CMO-001", "D-CMO-003"],
    goal_type: "achieve",
  },
  {
    id: "G-S005",
    agentId: "vw-cmo",
    name: "Achieve 45% Repeat Purchase Rate",
    description: "Build customer loyalty from 25% to 45% repeat purchase rate",
    hierarchy_level: "strategic",
    priority: 0.87,
    success_criteria: "Repeat rate >= 45%",
    deadline: "2030-12-31",
    desire_ids: ["D-CMO-002"],
    goal_type: "achieve",
  },
  {
    id: "G-S006",
    agentId: "vw-cmo",
    name: "Reduce CAC to $60",
    description:
      "Halve customer acquisition cost from $120 to $60 through organic and referral growth",
    hierarchy_level: "strategic",
    priority: 0.82,
    success_criteria: "CAC <= $60",
    deadline: "2030-12-31",
    desire_ids: ["D-CMO-002", "D-CFO-003"],
    goal_type: "achieve",
  },
  {
    id: "G-S007",
    agentId: "vw-cmo",
    name: "Scale Limited Edition to 20% Revenue Mix",
    description:
      "Grow limited edition share from 10% to 20% of total revenue with 50% price premium",
    hierarchy_level: "strategic",
    priority: 0.86,
    success_criteria: "LE revenue mix >= 20%",
    deadline: "2030-12-31",
    desire_ids: ["D-CMO-003"],
    goal_type: "achieve",
  },
  {
    id: "G-S008",
    agentId: "vw-ceo",
    name: "Expand to International Markets",
    description: "Launch in EU and Asia markets by Year 4-5",
    hierarchy_level: "strategic",
    priority: 0.8,
    success_criteria: "Active in >= 3 international markets",
    deadline: "2030-12-31",
    desire_ids: ["D-CEO-003"],
    goal_type: "achieve",
  },
  {
    id: "G-S009",
    agentId: "vw-cto",
    name: "Launch AR Preview Technology",
    description: "Develop augmented reality wall art preview feature for customers",
    hierarchy_level: "strategic",
    priority: 0.78,
    success_criteria: "AR feature live in production",
    deadline: "2028-12-31",
    desire_ids: ["D-CTO-003"],
    goal_type: "achieve",
  },
  {
    id: "G-S010",
    agentId: "vw-cto",
    name: "Build Proprietary AI Art Generation",
    description: "Create custom AI art generation service for unique VividWalls collections",
    hierarchy_level: "strategic",
    priority: 0.75,
    success_criteria: "AI generation MVP launched",
    deadline: "2030-12-31",
    desire_ids: ["D-CTO-002"],
    goal_type: "achieve",
  },
  {
    id: "G-S011",
    agentId: "vw-coo",
    name: "Open Physical Showroom",
    description: "Establish physical showroom in major metropolitan market",
    hierarchy_level: "strategic",
    priority: 0.7,
    success_criteria: "Showroom open and operational",
    deadline: "2030-12-31",
    desire_ids: ["D-COO-001"],
    goal_type: "achieve",
  },
  {
    id: "G-S012",
    agentId: "vw-coo",
    name: "Achieve $1.14M Revenue Per Employee",
    description: "Increase employee productivity from $460K to $1.14M revenue per employee",
    hierarchy_level: "strategic",
    priority: 0.82,
    success_criteria: "Rev/employee >= $1.14M",
    deadline: "2030-12-31",
    desire_ids: ["D-COO-001"],
    goal_type: "achieve",
  },

  // ── Tactical Goals (Year 1-2) ─────────────────────────────────────
  {
    id: "G-T001",
    agentId: "vw-cfo",
    name: "Reach $2.3M Revenue Year 1",
    description: "Achieve first year revenue target of $2.3M",
    hierarchy_level: "tactical",
    priority: 0.93,
    success_criteria: "Y1 revenue >= $2.3M",
    deadline: "2026-12-31",
    parent_goal_id: "G-S001",
    desire_ids: ["D-CFO-002"],
    goal_type: "achieve",
  },
  {
    id: "G-T002",
    agentId: "vw-cfo",
    name: "Reach $4.0M Revenue Year 2",
    description: "Achieve 74% growth to $4.0M in second year",
    hierarchy_level: "tactical",
    priority: 0.88,
    success_criteria: "Y2 revenue >= $4.0M",
    deadline: "2027-12-31",
    parent_goal_id: "G-S001",
    desire_ids: ["D-CFO-002"],
    goal_type: "achieve",
  },
  {
    id: "G-T003",
    agentId: "vw-cfo",
    name: "Achieve Positive EBITDA by Year 2",
    description: "Move from -12% to 11% EBITDA margin",
    hierarchy_level: "tactical",
    priority: 0.9,
    success_criteria: "EBITDA > 0",
    deadline: "2027-12-31",
    parent_goal_id: "G-S002",
    desire_ids: ["D-CFO-001"],
    goal_type: "achieve",
  },
  {
    id: "G-T004",
    agentId: "vw-coo",
    name: "Process 3,833 Orders Year 1",
    description: "Build fulfillment capacity for 319 orders/month",
    hierarchy_level: "tactical",
    priority: 0.85,
    success_criteria: "Y1 orders >= 3,833",
    deadline: "2026-12-31",
    parent_goal_id: "G-S003",
    desire_ids: ["D-COO-001"],
    goal_type: "achieve",
  },
  {
    id: "G-T005",
    agentId: "vw-cmo",
    name: "Maintain $600 AOV Year 1",
    description: "Establish baseline AOV at $600 across all segments",
    hierarchy_level: "tactical",
    priority: 0.83,
    success_criteria: "AOV >= $600",
    deadline: "2026-12-31",
    parent_goal_id: "G-S004",
    desire_ids: ["D-CMO-001"],
    goal_type: "maintain",
  },
  {
    id: "G-T006",
    agentId: "vw-cmo",
    name: "Achieve 25% Repeat Purchase Rate Year 1",
    description: "Build initial customer loyalty and retention",
    hierarchy_level: "tactical",
    priority: 0.8,
    success_criteria: "Repeat rate >= 25%",
    deadline: "2026-12-31",
    parent_goal_id: "G-S005",
    desire_ids: ["D-CMO-002"],
    goal_type: "achieve",
  },
  {
    id: "G-T007",
    agentId: "vw-cmo",
    name: "Reduce CAC to $120 Year 1",
    description: "Optimize marketing spend efficiency in first year",
    hierarchy_level: "tactical",
    priority: 0.78,
    success_criteria: "CAC <= $120",
    deadline: "2026-12-31",
    parent_goal_id: "G-S006",
    desire_ids: ["D-CMO-002"],
    goal_type: "achieve",
  },
  {
    id: "G-T008",
    agentId: "vw-cmo",
    name: "Launch LE Program at 10% Mix",
    description: "Establish limited edition program with initial 10% revenue share",
    hierarchy_level: "tactical",
    priority: 0.85,
    success_criteria: "LE mix >= 10%",
    deadline: "2026-12-31",
    parent_goal_id: "G-S007",
    desire_ids: ["D-CMO-003"],
    goal_type: "achieve",
  },
  {
    id: "G-T009",
    agentId: "vw-cmo",
    name: "Achieve 35% LE Price Premium Year 1",
    description: "Price limited editions at 35% above standard prints",
    hierarchy_level: "tactical",
    priority: 0.82,
    success_criteria: "LE premium >= 35%",
    deadline: "2026-12-31",
    parent_goal_id: "G-S007",
    desire_ids: ["D-CMO-003"],
    goal_type: "maintain",
  },
  {
    id: "G-T010",
    agentId: "vw-cto",
    name: "Research AR Preview Feasibility",
    description: "Evaluate AR technology options and build proof-of-concept",
    hierarchy_level: "tactical",
    priority: 0.7,
    success_criteria: "Feasibility report delivered",
    deadline: "2027-06-30",
    parent_goal_id: "G-S009",
    desire_ids: ["D-CTO-003"],
    goal_type: "query",
  },
  {
    id: "G-T011",
    agentId: "vw-cmo",
    name: "Grow Consumer Segment to 65% Revenue",
    description: "Build individual art collector customer base as primary revenue driver",
    hierarchy_level: "tactical",
    priority: 0.8,
    success_criteria: "Consumer revenue >= 65%",
    deadline: "2026-12-31",
    parent_goal_id: "G-S003",
    desire_ids: ["D-CMO-002"],
    goal_type: "achieve",
  },
  {
    id: "G-T012",
    agentId: "vw-cmo",
    name: "Build Designer Segment to 25% Revenue",
    description: "Develop interior designer trade program partnerships",
    hierarchy_level: "tactical",
    priority: 0.78,
    success_criteria: "Designer revenue >= 25%",
    deadline: "2027-12-31",
    parent_goal_id: "G-S003",
    desire_ids: ["D-CMO-002"],
    goal_type: "achieve",
  },
  {
    id: "G-T013",
    agentId: "vw-cmo",
    name: "Develop Commercial Segment to 15% Revenue",
    description: "Build B2B commercial accounts for hotels, offices, healthcare",
    hierarchy_level: "tactical",
    priority: 0.75,
    success_criteria: "Commercial revenue >= 15%",
    deadline: "2027-12-31",
    parent_goal_id: "G-S003",
    desire_ids: ["D-CMO-002"],
    goal_type: "achieve",
  },
  {
    id: "G-T014",
    agentId: "vw-coo",
    name: "Optimize Fulfillment to <7 Days",
    description: "Streamline order-to-delivery pipeline",
    hierarchy_level: "tactical",
    priority: 0.85,
    success_criteria: "Avg fulfillment <= 7 days",
    deadline: "2026-12-31",
    parent_goal_id: "G-S012",
    desire_ids: ["D-COO-001"],
    goal_type: "achieve",
  },
  {
    id: "G-T015",
    agentId: "vw-coo",
    name: "Reduce COGS from 60% to 55% Year 2",
    description: "Improve gross margins through scale and supplier negotiations",
    hierarchy_level: "tactical",
    priority: 0.82,
    success_criteria: "COGS <= 55%",
    deadline: "2027-12-31",
    parent_goal_id: "G-S002",
    desire_ids: ["D-COO-001", "D-CFO-003"],
    goal_type: "achieve",
  },

  // ── Operational Goals (Monthly/Weekly) ────────────────────────────
  {
    id: "G-O001",
    agentId: "vw-cfo",
    name: "Generate $192K Monthly Revenue",
    description: "Maintain monthly revenue run-rate of $192K to hit $2.3M annual target",
    hierarchy_level: "operational",
    priority: 0.9,
    success_criteria: "Monthly revenue >= $192K",
    deadline: "ongoing",
    parent_goal_id: "G-T001",
    desire_ids: ["D-CFO-002"],
    goal_type: "maintain",
  },
  {
    id: "G-O002",
    agentId: "vw-coo",
    name: "Fulfill 319 Orders/Month",
    description: "Process and ship average 319 orders per month",
    hierarchy_level: "operational",
    priority: 0.88,
    success_criteria: "Monthly orders >= 319",
    deadline: "ongoing",
    parent_goal_id: "G-T004",
    desire_ids: ["D-COO-001"],
    goal_type: "maintain",
  },
  {
    id: "G-O003",
    agentId: "vw-cmo",
    name: "Maintain $600 AOV Across Channels",
    description: "Monitor and optimize AOV across web, social, and partner channels",
    hierarchy_level: "operational",
    priority: 0.82,
    success_criteria: "Rolling 30-day AOV >= $600",
    deadline: "ongoing",
    parent_goal_id: "G-T005",
    desire_ids: ["D-CMO-001"],
    goal_type: "maintain",
  },
  {
    id: "G-O004",
    agentId: "vw-cmo",
    name: "Run Monthly Email Retention Campaigns",
    description: "Execute targeted email campaigns for customer retention and repeat purchases",
    hierarchy_level: "operational",
    priority: 0.78,
    success_criteria: "1 campaign/month, 30%+ open rate",
    deadline: "ongoing",
    parent_goal_id: "G-T006",
    desire_ids: ["D-CMO-002"],
    goal_type: "maintain",
  },
  {
    id: "G-O005",
    agentId: "vw-cmo",
    name: "Optimize Ad Spend to <$120/Acquisition",
    description: "Manage Facebook, Instagram, Pinterest ad budgets for CAC efficiency",
    hierarchy_level: "operational",
    priority: 0.8,
    success_criteria: "Blended CAC <= $120",
    deadline: "ongoing",
    parent_goal_id: "G-T007",
    desire_ids: ["D-CMO-002"],
    goal_type: "maintain",
  },
  {
    id: "G-O006",
    agentId: "vw-cmo",
    name: "Curate First 3 Limited Edition Collections",
    description: "Select and launch initial LE collections with numbered certificates",
    hierarchy_level: "operational",
    priority: 0.85,
    success_criteria: "3 LE collections launched",
    deadline: "2026-06-30",
    parent_goal_id: "G-T008",
    desire_ids: ["D-CMO-003"],
    goal_type: "achieve",
  },
  {
    id: "G-O007",
    agentId: "vw-coo",
    name: "Produce 50-100 Prints Per LE Run",
    description: "Manage limited edition print runs at 50-100 units with quality control",
    hierarchy_level: "operational",
    priority: 0.8,
    success_criteria: "Each LE run 50-100 units",
    deadline: "ongoing",
    parent_goal_id: "G-T008",
    desire_ids: ["D-COO-001", "D-COO-003"],
    goal_type: "maintain",
  },
  {
    id: "G-O008",
    agentId: "vw-cmo",
    name: "Price LEs at 35% Premium Over Standard",
    description: "Set and maintain limited edition pricing at 35% above standard prints",
    hierarchy_level: "operational",
    priority: 0.78,
    success_criteria: "LE price premium >= 35%",
    deadline: "ongoing",
    parent_goal_id: "G-T009",
    desire_ids: ["D-CMO-003"],
    goal_type: "maintain",
  },
  {
    id: "G-O009",
    agentId: "vw-coo",
    name: "Maintain <24hr Customer Response Time",
    description: "Respond to all customer inquiries within 24 hours",
    hierarchy_level: "operational",
    priority: 0.85,
    success_criteria: "Avg response time < 24hrs",
    deadline: "ongoing",
    parent_goal_id: "G-T014",
    desire_ids: ["D-COO-001"],
    goal_type: "maintain",
  },
  {
    id: "G-O010",
    agentId: "vw-coo",
    name: "Achieve 95%+ Print Quality Score",
    description: "Maintain 300+ DPI, 95%+ color accuracy on all prints",
    hierarchy_level: "operational",
    priority: 0.88,
    success_criteria: "Quality score >= 95%",
    deadline: "ongoing",
    parent_goal_id: "G-T014",
    desire_ids: ["D-COO-003"],
    goal_type: "maintain",
  },
  {
    id: "G-O011",
    agentId: "vw-coo",
    name: "Negotiate Bulk Material Discounts",
    description: "Secure volume discounts with canvas, ink, and framing suppliers",
    hierarchy_level: "operational",
    priority: 0.75,
    success_criteria: ">=10% discount on bulk orders",
    deadline: "2026-09-30",
    parent_goal_id: "G-T015",
    desire_ids: ["D-COO-002"],
    goal_type: "achieve",
  },
  {
    id: "G-O012",
    agentId: "vw-cmo",
    name: "Run Facebook/Instagram/Pinterest Campaigns",
    description: "Execute weekly social media advertising across 3 platforms",
    hierarchy_level: "operational",
    priority: 0.8,
    success_criteria: "Active campaigns on 3 platforms",
    deadline: "ongoing",
    parent_goal_id: "G-T011",
    desire_ids: ["D-CMO-002"],
    goal_type: "maintain",
  },
  {
    id: "G-O013",
    agentId: "vw-cmo",
    name: "Recruit 50 Interior Designer Partners",
    description: "Build trade program with 50 active designer accounts",
    hierarchy_level: "operational",
    priority: 0.75,
    success_criteria: ">=50 designer accounts",
    deadline: "2026-12-31",
    parent_goal_id: "G-T012",
    desire_ids: ["D-CMO-002"],
    goal_type: "achieve",
  },
  {
    id: "G-O014",
    agentId: "vw-cmo",
    name: "Close 5 Commercial Accounts",
    description: "Sign 5 commercial clients (hotels, offices, healthcare facilities)",
    hierarchy_level: "operational",
    priority: 0.73,
    success_criteria: ">=5 commercial accounts",
    deadline: "2026-12-31",
    parent_goal_id: "G-T013",
    desire_ids: ["D-CMO-002"],
    goal_type: "achieve",
  },
  {
    id: "G-O015",
    agentId: "vw-coo",
    name: "Reduce Return Rate to <5%",
    description: "Minimize returns through quality assurance and accurate product imagery",
    hierarchy_level: "operational",
    priority: 0.82,
    success_criteria: "Return rate < 5%",
    deadline: "ongoing",
    parent_goal_id: "G-T015",
    desire_ids: ["D-COO-003"],
    goal_type: "avoid",
  },
];

interface BeliefSeed {
  id: string;
  agentId: string;
  category: string;
  certainty: number;
  subject: string;
  content: string;
  source: string;
  supports_goals: string[];
}

const BELIEFS: BeliefSeed[] = [
  {
    id: "B-001",
    agentId: "vw-cmo",
    category: "environment",
    certainty: 0.85,
    subject: "target-market",
    content:
      "VividWalls target market is 35-65 year olds with household income >$75K who value quality art for personal spaces",
    source: "BRD market research",
    supports_goals: ["G-S003", "G-T011"],
  },
  {
    id: "B-002",
    agentId: "vw-cfo",
    category: "environment",
    certainty: 0.8,
    subject: "pricing-power",
    content:
      "Premium abstract art market supports $600+ average order value with free shipping threshold at $250",
    source: "BMC pricing analysis",
    supports_goals: ["G-S004", "G-T005"],
  },
  {
    id: "B-003",
    agentId: "vw-cmo",
    category: "environment",
    certainty: 0.9,
    subject: "scarcity-value",
    content:
      "Limited editions at 50-100 units with numbered certificates drive 25-50% price premium via FOMO",
    source: "LE strategy analysis",
    supports_goals: ["G-S007", "G-T008", "G-T009"],
  },
  {
    id: "B-004",
    agentId: "vw-cto",
    category: "self",
    certainty: 0.75,
    subject: "ai-efficiency",
    content:
      "AI-driven operations can reduce costs by 12% over 5 years while improving personalization",
    source: "Financial model projection",
    supports_goals: ["G-S002", "G-S010"],
  },
  {
    id: "B-005",
    agentId: "vw-cmo",
    category: "environment",
    certainty: 0.8,
    subject: "designer-channel",
    content:
      "Interior designer channel represents 25% revenue opportunity with 10% trade discount model",
    source: "BMC channel analysis",
    supports_goals: ["G-T012", "G-O013"],
  },
  {
    id: "B-006",
    agentId: "vw-coo",
    category: "self",
    certainty: 0.85,
    subject: "quality-standard",
    content:
      "300+ DPI print resolution with 95%+ color accuracy and archival inks is achievable at scale",
    source: "Production capability assessment",
    supports_goals: ["G-O010", "G-O015"],
  },
  {
    id: "B-007",
    agentId: "vw-cfo",
    category: "environment",
    certainty: 0.7,
    subject: "market-risk",
    content:
      "New AI-driven art platforms pose competitive threat but VividWalls' quality focus provides defensibility",
    source: "Competitive analysis",
    supports_goals: ["G-S008"],
  },
  {
    id: "B-008",
    agentId: "vw-cmo",
    category: "environment",
    certainty: 0.78,
    subject: "commercial-opportunity",
    content:
      "Hotels, offices, and healthcare facilities represent $3,600 average order commercial segment",
    source: "BMC segment analysis",
    supports_goals: ["G-T013", "G-O014"],
  },
];

// ── Precondition Seed Data ────────────────────────────────────────────────

interface PreconditionSeed {
  id: string;
  agentId: string;
  goalId: string;
  name: string;
  type: string;
  expression: string;
  referencedGoalId?: string;
  satisfied?: boolean;
}

const PRECONDITIONS: PreconditionSeed[] = [
  {
    id: "PC-001",
    agentId: "vw-cfo",
    goalId: "G-T001",
    name: "Budget Approved",
    type: "condition",
    expression: "budget_approved == true",
    satisfied: true,
  },
  {
    id: "PC-002",
    agentId: "vw-cmo",
    goalId: "G-T008",
    name: "Consumer Segment Established",
    type: "goal_state",
    expression: "G-T011.goal_state == active",
    referencedGoalId: "G-T011",
    satisfied: true,
  },
  {
    id: "PC-003",
    agentId: "vw-coo",
    goalId: "G-T014",
    name: "Fulfillment Capacity Ready",
    type: "goal_state",
    expression: "G-T004.goal_state == active",
    referencedGoalId: "G-T004",
    satisfied: true,
  },
  {
    id: "PC-004",
    agentId: "vw-cto",
    goalId: "G-T010",
    name: "Platform Infrastructure Stable",
    type: "condition",
    expression: "platform_uptime >= 99.5",
    satisfied: true,
  },
  {
    id: "PC-005",
    agentId: "vw-cmo",
    goalId: "G-T012",
    name: "Trade Program Designed",
    type: "condition",
    expression: "trade_program_spec_approved == true",
    satisfied: false,
  },
];

// ── Delegation Seed Data ─────────────────────────────────────────────────

interface DelegationSeed {
  from: string;
  to: string;
  goalIds: string[];
}

const DELEGATIONS: DelegationSeed[] = [
  // Stakeholder → C-suite (strategic goals)
  // CMO → Marketing Director, Sales Director, Creative Director
  {
    from: "vw-cmo",
    to: "vw-marketing-director",
    goalIds: ["G-T011", "G-T007", "G-O012", "G-O005"],
  },
  {
    from: "vw-cmo",
    to: "vw-sales-director",
    goalIds: ["G-T012", "G-T013", "G-O013", "G-O014"],
  },
  {
    from: "vw-cmo",
    to: "vw-creative-director",
    goalIds: ["G-T008", "G-T009", "G-O006", "G-O008"],
  },
  // COO → Inventory Mgr, Fulfillment Mgr, Product Mgr, CS Director
  {
    from: "vw-coo",
    to: "vw-inventory-mgr",
    goalIds: ["G-O011", "G-T015"],
  },
  {
    from: "vw-coo",
    to: "vw-fulfillment-mgr",
    goalIds: ["G-T004", "G-T014", "G-O002", "G-O007"],
  },
  {
    from: "vw-coo",
    to: "vw-product-mgr",
    goalIds: ["G-S011", "G-O010", "G-O015"],
  },
  {
    from: "vw-coo",
    to: "vw-cs-director",
    goalIds: ["G-O009"],
  },
  // CFO → Compliance Director
  {
    from: "vw-cfo",
    to: "vw-compliance-director",
    goalIds: ["G-T003", "G-S002"],
  },
];

// ── Decision Seed Data ───────────────────────────────────────────────────

interface DecisionSeed {
  id: string;
  agentId: string;
  name: string;
  description: string;
  urgency: string;
  options: any[];
  recommendation?: string;
  goalIds: string[]; // goals this decision resolves
}

const DECISIONS: DecisionSeed[] = [
  {
    id: "DEC-001",
    agentId: "vw-ceo",
    name: "Expand to European Market",
    description:
      "Evaluate whether to enter the EU market in Year 2 or wait until Year 3 for stronger US foundation",
    urgency: "high",
    options: [
      {
        id: "opt-1",
        label: "Enter EU Year 2",
        description: "Aggressive expansion targeting UK, Germany, France",
        recommended: true,
      },
      {
        id: "opt-2",
        label: "Defer to Year 3",
        description: "Focus on US market dominance first",
        recommended: false,
      },
      {
        id: "opt-3",
        label: "EU Partnership Model",
        description: "License to EU partner rather than direct entry",
        recommended: false,
      },
    ],
    recommendation:
      "Enter EU Year 2 — our brand positioning is strong enough and first-mover advantage in premium abstract art is critical",
    goalIds: ["G-S008"],
  },
  {
    id: "DEC-002",
    agentId: "vw-cfo",
    name: "Select Payment Processor",
    description: "Choose between Stripe, Square, or PayPal Commerce for primary payment processing",
    urgency: "medium",
    options: [
      {
        id: "opt-1",
        label: "Stripe",
        description: "2.9% + $0.30, best API, supports subscriptions",
        recommended: true,
      },
      {
        id: "opt-2",
        label: "Square",
        description: "2.6% + $0.10, good for POS if showroom opens",
        recommended: false,
      },
      {
        id: "opt-3",
        label: "PayPal Commerce",
        description: "2.59% + $0.49, highest buyer trust",
        recommended: false,
      },
    ],
    recommendation:
      "Stripe — best developer experience and supports our subscription/LE pre-order model",
    goalIds: ["G-T001"],
  },
  {
    id: "DEC-003",
    agentId: "vw-cto",
    name: "Cloud Provider Migration",
    description:
      "Current hosting on shared infrastructure; need to decide on dedicated cloud provider for scaling",
    urgency: "high",
    options: [
      {
        id: "opt-1",
        label: "AWS",
        description: "Most services, best for e-commerce, CDN via CloudFront",
        recommended: true,
      },
      {
        id: "opt-2",
        label: "Vercel + Cloudflare",
        description: "Simpler deployment, edge-first",
        recommended: false,
      },
      {
        id: "opt-3",
        label: "GCP",
        description: "Better AI/ML integration for future features",
        recommended: false,
      },
    ],
    recommendation:
      "AWS — mature e-commerce tooling (S3 for art storage, CloudFront CDN, Lambda for image processing)",
    goalIds: ["G-S009", "G-S010"],
  },
  {
    id: "DEC-004",
    agentId: "vw-cmo",
    name: "Limited Edition Launch Strategy",
    description: "Choose the go-to-market strategy for our first 3 limited edition collections",
    urgency: "high",
    options: [
      {
        id: "opt-1",
        label: "Waitlist + Drop Model",
        description: "Build anticipation with waitlist, then timed drops",
        recommended: true,
      },
      {
        id: "opt-2",
        label: "Auction Model",
        description: "Let market set prices through auctions",
        recommended: false,
      },
      {
        id: "opt-3",
        label: "First-Come-First-Served",
        description: "Simple launch, whoever buys first gets it",
        recommended: false,
      },
    ],
    recommendation:
      "Waitlist + Drop Model — creates FOMO, builds email list, and allows pre-demand estimation",
    goalIds: ["G-T008", "G-T009"],
  },
  {
    id: "DEC-005",
    agentId: "vw-coo",
    name: "Print Production Partner",
    description: "Select primary print-on-demand partner or bring printing in-house",
    urgency: "medium",
    options: [
      {
        id: "opt-1",
        label: "In-House Production",
        description: "Buy printers, hire staff, full quality control",
        recommended: false,
      },
      {
        id: "opt-2",
        label: "Printful White-Label",
        description: "Outsource to Printful with custom quality specs",
        recommended: true,
      },
      {
        id: "opt-3",
        label: "Hybrid Model",
        description: "In-house for LE, outsource standard prints",
        recommended: false,
      },
    ],
    recommendation:
      "Printful White-Label for Year 1, then transition LE production in-house by Year 2",
    goalIds: ["G-T004", "G-T014"],
  },
];

// ── Workflow / Task Seed Data ────────────────────────────────────────────

interface WorkflowSeed {
  id: string;
  agentId: string;
  name: string;
  workflowType: string;
  trigger: string;
  planId: string;
  planName: string;
  goalId: string; // goal this workflow serves
  schedule?: string; // cron expression for workflow-level schedule
  scheduleTimezone?: string;
  steps: Array<{
    id: string;
    name: string;
    stepType: string;
    order: number;
    estimatedDuration: string;
    schedule?: string; // cron expression for step-level schedule
    action?: string; // tool name mapped to this step
  }>;
  tasks: Array<{
    id: string;
    name: string;
    description: string;
    taskType: string;
    assignedAgentId: string;
    priority: number;
    estimatedDuration: string;
    dependsOnIds?: string;
  }>;
}

const WORKFLOWS: WorkflowSeed[] = [
  {
    id: "WF-001",
    agentId: "vw-cmo",
    name: "Market Research Pipeline",
    workflowType: "research",
    trigger: "quarterly",
    planId: "PLAN-MR-001",
    planName: "Q1 Market Research Plan",
    goalId: "G-T011",
    steps: [
      {
        id: "PS-MR-001",
        name: "Competitor Analysis",
        stepType: "research",
        order: 1,
        estimatedDuration: "3d",
      },
      {
        id: "PS-MR-002",
        name: "Customer Segmentation Update",
        stepType: "analysis",
        order: 2,
        estimatedDuration: "2d",
      },
      {
        id: "PS-MR-003",
        name: "Pricing Strategy Review",
        stepType: "review",
        order: 3,
        estimatedDuration: "1d",
      },
      {
        id: "PS-MR-004",
        name: "Campaign Planning",
        stepType: "planning",
        order: 4,
        estimatedDuration: "2d",
      },
      {
        id: "PS-MR-005",
        name: "Report & Recommendations",
        stepType: "deliverable",
        order: 5,
        estimatedDuration: "1d",
      },
    ],
    tasks: [
      {
        id: "T-MR-001",
        name: "Analyze competitor pricing",
        description: "Review top 5 competitor pricing strategies and market positioning",
        taskType: "research",
        assignedAgentId: "vw-cmo",
        priority: 0.85,
        estimatedDuration: "2d",
      },
      {
        id: "T-MR-002",
        name: "Survey customer preferences",
        description: "Run customer preference survey on art styles and price sensitivity",
        taskType: "research",
        assignedAgentId: "vw-cmo",
        priority: 0.8,
        estimatedDuration: "3d",
      },
      {
        id: "T-MR-003",
        name: "Update buyer personas",
        description: "Refresh buyer personas based on Q4 data",
        taskType: "analysis",
        assignedAgentId: "vw-cmo",
        priority: 0.75,
        estimatedDuration: "1d",
        dependsOnIds: "T-MR-002",
      },
      {
        id: "T-MR-004",
        name: "A/B test ad creatives",
        description: "Test 3 ad creative variants across Facebook and Instagram",
        taskType: "execution",
        assignedAgentId: "vw-cmo",
        priority: 0.8,
        estimatedDuration: "5d",
      },
      {
        id: "T-MR-005",
        name: "Evaluate SEO performance",
        description: "Audit organic search rankings and optimize content strategy",
        taskType: "analysis",
        assignedAgentId: "vw-cmo",
        priority: 0.7,
        estimatedDuration: "2d",
      },
      {
        id: "T-MR-006",
        name: "Draft marketing report",
        description: "Compile research findings into quarterly marketing report",
        taskType: "deliverable",
        assignedAgentId: "vw-cmo",
        priority: 0.9,
        estimatedDuration: "1d",
        dependsOnIds: "T-MR-001,T-MR-003,T-MR-005",
      },
    ],
  },
  {
    id: "WF-002",
    agentId: "vw-cfo",
    name: "Revenue Optimization Workflow",
    workflowType: "optimization",
    trigger: "monthly",
    planId: "PLAN-RO-001",
    planName: "Revenue Optimization Plan",
    goalId: "G-T001",
    steps: [
      {
        id: "PS-RO-001",
        name: "Revenue Dashboard Review",
        stepType: "review",
        order: 1,
        estimatedDuration: "1d",
      },
      {
        id: "PS-RO-002",
        name: "Margin Analysis",
        stepType: "analysis",
        order: 2,
        estimatedDuration: "2d",
      },
      {
        id: "PS-RO-003",
        name: "Pricing Adjustments",
        stepType: "action",
        order: 3,
        estimatedDuration: "1d",
      },
      {
        id: "PS-RO-004",
        name: "Cost Reduction Initiatives",
        stepType: "action",
        order: 4,
        estimatedDuration: "3d",
      },
      {
        id: "PS-RO-005",
        name: "Financial Forecast Update",
        stepType: "deliverable",
        order: 5,
        estimatedDuration: "1d",
      },
    ],
    tasks: [
      {
        id: "T-RO-001",
        name: "Generate monthly P&L",
        description: "Pull revenue, COGS, and expense data for monthly P&L statement",
        taskType: "reporting",
        assignedAgentId: "vw-cfo",
        priority: 0.9,
        estimatedDuration: "1d",
      },
      {
        id: "T-RO-002",
        name: "Analyze product margins",
        description: "Calculate margin by product category (standard, premium, LE)",
        taskType: "analysis",
        assignedAgentId: "vw-cfo",
        priority: 0.85,
        estimatedDuration: "1d",
      },
      {
        id: "T-RO-003",
        name: "Review supplier costs",
        description: "Compare current supplier costs against market rates",
        taskType: "analysis",
        assignedAgentId: "vw-coo",
        priority: 0.75,
        estimatedDuration: "2d",
      },
      {
        id: "T-RO-004",
        name: "Adjust pricing tiers",
        description: "Recommend pricing changes based on margin analysis",
        taskType: "action",
        assignedAgentId: "vw-cfo",
        priority: 0.8,
        estimatedDuration: "1d",
        dependsOnIds: "T-RO-002",
      },
      {
        id: "T-RO-005",
        name: "Update financial model",
        description: "Refresh 5-year financial model with actual vs projected",
        taskType: "modeling",
        assignedAgentId: "vw-cfo",
        priority: 0.85,
        estimatedDuration: "2d",
        dependsOnIds: "T-RO-001,T-RO-002",
      },
      {
        id: "T-RO-006",
        name: "Investor-ready report",
        description: "Prepare financial summary for stakeholder review",
        taskType: "deliverable",
        assignedAgentId: "vw-cfo",
        priority: 0.9,
        estimatedDuration: "1d",
        dependsOnIds: "T-RO-005",
      },
    ],
  },
  {
    id: "WF-003",
    agentId: "vw-cto",
    name: "Tech Infrastructure Setup",
    workflowType: "infrastructure",
    trigger: "milestone",
    planId: "PLAN-TI-001",
    planName: "Platform Infrastructure Plan",
    goalId: "G-S009",
    steps: [
      {
        id: "PS-TI-001",
        name: "Architecture Design",
        stepType: "planning",
        order: 1,
        estimatedDuration: "5d",
      },
      {
        id: "PS-TI-002",
        name: "Cloud Environment Setup",
        stepType: "infrastructure",
        order: 2,
        estimatedDuration: "3d",
      },
      {
        id: "PS-TI-003",
        name: "CI/CD Pipeline",
        stepType: "infrastructure",
        order: 3,
        estimatedDuration: "2d",
      },
      {
        id: "PS-TI-004",
        name: "Monitoring & Alerting",
        stepType: "infrastructure",
        order: 4,
        estimatedDuration: "2d",
      },
      {
        id: "PS-TI-005",
        name: "Security Hardening",
        stepType: "security",
        order: 5,
        estimatedDuration: "3d",
      },
      {
        id: "PS-TI-006",
        name: "Performance Testing",
        stepType: "testing",
        order: 6,
        estimatedDuration: "2d",
      },
    ],
    tasks: [
      {
        id: "T-TI-001",
        name: "Design system architecture",
        description:
          "Create architecture diagram for e-commerce platform with CDN, image processing, and payment integration",
        taskType: "planning",
        assignedAgentId: "vw-cto",
        priority: 0.95,
        estimatedDuration: "3d",
      },
      {
        id: "T-TI-002",
        name: "Set up cloud infrastructure",
        description:
          "Provision AWS resources: S3 buckets, CloudFront distributions, Lambda functions, RDS",
        taskType: "infrastructure",
        assignedAgentId: "vw-cto",
        priority: 0.9,
        estimatedDuration: "3d",
        dependsOnIds: "T-TI-001",
      },
      {
        id: "T-TI-003",
        name: "Configure CDN for art delivery",
        description:
          "Set up CloudFront with image optimization for high-res art delivery worldwide",
        taskType: "infrastructure",
        assignedAgentId: "vw-cto",
        priority: 0.85,
        estimatedDuration: "2d",
        dependsOnIds: "T-TI-002",
      },
      {
        id: "T-TI-004",
        name: "Build image processing pipeline",
        description:
          "Create Lambda-based pipeline for art resizing, watermarking, and format conversion",
        taskType: "development",
        assignedAgentId: "vw-cto",
        priority: 0.85,
        estimatedDuration: "5d",
        dependsOnIds: "T-TI-002",
      },
      {
        id: "T-TI-005",
        name: "Implement monitoring",
        description:
          "Set up DataDog/CloudWatch monitoring with uptime alerts and performance dashboards",
        taskType: "infrastructure",
        assignedAgentId: "vw-cto",
        priority: 0.8,
        estimatedDuration: "2d",
        dependsOnIds: "T-TI-002",
      },
      {
        id: "T-TI-006",
        name: "Run load tests",
        description:
          "Load test platform to verify it handles 500+ concurrent users and 1000 orders/day",
        taskType: "testing",
        assignedAgentId: "vw-cto",
        priority: 0.8,
        estimatedDuration: "2d",
        dependsOnIds: "T-TI-003,T-TI-004",
      },
    ],
  },

  // ── Marketing Workflow System (WF-100 → WF-110) ────────────────────────

  {
    id: "WF-100",
    agentId: "vw-cmo",
    name: "Lead Generation Pipeline",
    workflowType: "marketing",
    trigger: "scheduled",
    planId: "PLAN-LG-100",
    planName: "Lead Generation Plan",
    goalId: "G-T007",
    schedule: "0 8 * * MON-FRI",
    scheduleTimezone: "America/New_York",
    steps: [
      {
        id: "PS-LG-001",
        name: "Lead Capture",
        stepType: "automation",
        order: 1,
        estimatedDuration: "ongoing",
        schedule: "0 */4 * * *",
        action: "lead_scoring",
      },
      {
        id: "PS-LG-002",
        name: "Qualification",
        stepType: "analysis",
        order: 2,
        estimatedDuration: "1d",
        schedule: "0 9 * * MON-FRI",
        action: "crm_pipeline",
      },
      {
        id: "PS-LG-003",
        name: "Nurture Trigger",
        stepType: "automation",
        order: 3,
        estimatedDuration: "ongoing",
        schedule: "0 10 * * 1,3,5",
        action: "email_campaign",
      },
      {
        id: "PS-LG-004",
        name: "Conversion Tracking",
        stepType: "monitoring",
        order: 4,
        estimatedDuration: "ongoing",
        schedule: "0 18 * * *",
        action: "conversion_tracker",
      },
      {
        id: "PS-LG-005",
        name: "Source Analysis",
        stepType: "reporting",
        order: 5,
        estimatedDuration: "1d",
        schedule: "0 9 * * MON",
        action: "analytics_dashboard",
      },
    ],
    tasks: [
      {
        id: "T-LG-001",
        name: "Configure lead scoring rules",
        description:
          "Set up scoring weights for engagement, company size, industry, budget, and recency",
        taskType: "configuration",
        assignedAgentId: "vw-cmo",
        priority: 0.9,
        estimatedDuration: "1d",
      },
      {
        id: "T-LG-002",
        name: "Build nurture email sequence",
        description: "Create 5-email drip sequence for qualified leads",
        taskType: "content",
        assignedAgentId: "vw-cmo",
        priority: 0.85,
        estimatedDuration: "3d",
      },
      {
        id: "T-LG-003",
        name: "Set up conversion funnels",
        description: "Configure visit->view->cart->checkout->purchase funnel tracking",
        taskType: "configuration",
        assignedAgentId: "vw-cmo",
        priority: 0.8,
        estimatedDuration: "1d",
      },
    ],
  },
  {
    id: "WF-101",
    agentId: "vw-cmo",
    name: "Social Media Management",
    workflowType: "marketing",
    trigger: "scheduled",
    planId: "PLAN-SM-101",
    planName: "Social Media Management Plan",
    goalId: "G-O012",
    schedule: "0 7 * * *",
    scheduleTimezone: "America/New_York",
    steps: [
      {
        id: "PS-SM-001",
        name: "Calendar Review",
        stepType: "review",
        order: 1,
        estimatedDuration: "1h",
        schedule: "0 7 * * MON",
        action: "content_publish",
      },
      {
        id: "PS-SM-002",
        name: "Post Scheduling",
        stepType: "execution",
        order: 2,
        estimatedDuration: "1h",
        schedule: "0 8 * * MON-FRI",
        action: "content_publish",
      },
      {
        id: "PS-SM-003",
        name: "Engagement Monitor",
        stepType: "monitoring",
        order: 3,
        estimatedDuration: "ongoing",
        schedule: "0 */3 * * *",
        action: "ad_analytics",
      },
      {
        id: "PS-SM-004",
        name: "Analytics",
        stepType: "reporting",
        order: 4,
        estimatedDuration: "1h",
        schedule: "0 17 * * *",
        action: "analytics_dashboard",
      },
      {
        id: "PS-SM-005",
        name: "Trend Research",
        stepType: "research",
        order: 5,
        estimatedDuration: "2h",
        schedule: "0 9 * * WED",
        action: "seo_audit",
      },
    ],
    tasks: [
      {
        id: "T-SM-001",
        name: "Plan weekly content calendar",
        description:
          "Draft social media content calendar for the upcoming week across all platforms",
        taskType: "planning",
        assignedAgentId: "vw-cmo",
        priority: 0.85,
        estimatedDuration: "2h",
      },
      {
        id: "T-SM-002",
        name: "Create platform-specific posts",
        description: "Adapt content for Facebook, Instagram, Pinterest, and LinkedIn formats",
        taskType: "content",
        assignedAgentId: "vw-cmo",
        priority: 0.8,
        estimatedDuration: "3h",
      },
    ],
  },
  {
    id: "WF-102",
    agentId: "vw-cmo",
    name: "Email Marketing Lifecycle",
    workflowType: "marketing",
    trigger: "scheduled",
    planId: "PLAN-EM-102",
    planName: "Email Marketing Lifecycle Plan",
    goalId: "G-O004",
    schedule: "0 6 1 * *",
    scheduleTimezone: "America/New_York",
    steps: [
      {
        id: "PS-EM-001",
        name: "List Segmentation",
        stepType: "analysis",
        order: 1,
        estimatedDuration: "2h",
        schedule: "0 6 1 * *",
        action: "email_list_segment",
      },
      {
        id: "PS-EM-002",
        name: "Template Design",
        stepType: "creation",
        order: 2,
        estimatedDuration: "3d",
        schedule: "0 9 2-5 * *",
        action: "email_campaign",
      },
      {
        id: "PS-EM-003",
        name: "A/B Split",
        stepType: "testing",
        order: 3,
        estimatedDuration: "1d",
        schedule: "0 10 5 * *",
        action: "email_campaign",
      },
      {
        id: "PS-EM-004",
        name: "Campaign Send",
        stepType: "execution",
        order: 4,
        estimatedDuration: "1h",
        schedule: "0 10 7 * *",
        action: "email_campaign",
      },
      {
        id: "PS-EM-005",
        name: "Analysis",
        stepType: "reporting",
        order: 5,
        estimatedDuration: "2h",
        schedule: "0 9 10 * *",
        action: "analytics_dashboard",
      },
      {
        id: "PS-EM-006",
        name: "Bounce Cleanup",
        stepType: "maintenance",
        order: 6,
        estimatedDuration: "1h",
        schedule: "0 3 15 * *",
        action: "email_list_segment",
      },
    ],
    tasks: [
      {
        id: "T-EM-001",
        name: "Segment subscriber lists",
        description: "Create segments based on purchase history, engagement, and location",
        taskType: "analysis",
        assignedAgentId: "vw-cmo",
        priority: 0.85,
        estimatedDuration: "2h",
      },
      {
        id: "T-EM-002",
        name: "Design email templates",
        description: "Create responsive HTML templates for monthly campaign",
        taskType: "design",
        assignedAgentId: "vw-cmo",
        priority: 0.8,
        estimatedDuration: "2d",
      },
      {
        id: "T-EM-003",
        name: "Configure A/B test",
        description: "Set up subject line and CTA variations for split testing",
        taskType: "configuration",
        assignedAgentId: "vw-cmo",
        priority: 0.75,
        estimatedDuration: "1h",
      },
    ],
  },
  {
    id: "WF-103",
    agentId: "vw-cmo",
    name: "SEO & Content Optimization",
    workflowType: "marketing",
    trigger: "scheduled",
    planId: "PLAN-SEO-103",
    planName: "SEO & Content Optimization Plan",
    goalId: "G-O005",
    schedule: "0 8 * * MON",
    scheduleTimezone: "America/New_York",
    steps: [
      {
        id: "PS-SEO-001",
        name: "Rank Tracking",
        stepType: "monitoring",
        order: 1,
        estimatedDuration: "30m",
        schedule: "0 5 * * *",
        action: "keyword_tracker",
      },
      {
        id: "PS-SEO-002",
        name: "Gap Analysis",
        stepType: "analysis",
        order: 2,
        estimatedDuration: "2h",
        schedule: "0 9 * * MON",
        action: "seo_audit",
      },
      {
        id: "PS-SEO-003",
        name: "On-Page Optimization",
        stepType: "execution",
        order: 3,
        estimatedDuration: "3h",
        schedule: "0 10 * * TUE,THU",
        action: "seo_audit",
      },
      {
        id: "PS-SEO-004",
        name: "Backlink Monitor",
        stepType: "monitoring",
        order: 4,
        estimatedDuration: "1h",
        schedule: "0 8 * * WED",
        action: "keyword_tracker",
      },
      {
        id: "PS-SEO-005",
        name: "Tech Audit",
        stepType: "audit",
        order: 5,
        estimatedDuration: "4h",
        schedule: "0 3 1 * *",
        action: "seo_audit",
      },
    ],
    tasks: [
      {
        id: "T-SEO-001",
        name: "Add target keywords",
        description: "Add primary and long-tail keywords for abstract wall art niche",
        taskType: "configuration",
        assignedAgentId: "vw-cmo",
        priority: 0.85,
        estimatedDuration: "1h",
      },
      {
        id: "T-SEO-002",
        name: "Fix critical SEO issues",
        description: "Address missing schema markup and meta description issues from audit",
        taskType: "execution",
        assignedAgentId: "vw-cto",
        priority: 0.9,
        estimatedDuration: "2d",
      },
    ],
  },
  {
    id: "WF-104",
    agentId: "vw-cmo",
    name: "Customer Journey Orchestration",
    workflowType: "marketing",
    trigger: "scheduled",
    planId: "PLAN-CJ-104",
    planName: "Customer Journey Orchestration Plan",
    goalId: "G-T006",
    schedule: "0 */6 * * *",
    scheduleTimezone: "America/New_York",
    steps: [
      {
        id: "PS-CJ-001",
        name: "Touchpoint Tracking",
        stepType: "monitoring",
        order: 1,
        estimatedDuration: "ongoing",
        schedule: "*/30 * * * *",
        action: "conversion_tracker",
      },
      {
        id: "PS-CJ-002",
        name: "Behavior Analysis",
        stepType: "analysis",
        order: 2,
        estimatedDuration: "1h",
        schedule: "0 9 * * *",
        action: "analytics_dashboard",
      },
      {
        id: "PS-CJ-003",
        name: "Personalization Update",
        stepType: "automation",
        order: 3,
        estimatedDuration: "30m",
        schedule: "0 2 * * *",
        action: "email_list_segment",
      },
      {
        id: "PS-CJ-004",
        name: "Retention Eval",
        stepType: "analysis",
        order: 4,
        estimatedDuration: "1h",
        schedule: "0 */4 * * *",
        action: "crm_pipeline",
      },
      {
        id: "PS-CJ-005",
        name: "Churn Prediction",
        stepType: "analysis",
        order: 5,
        estimatedDuration: "2h",
        schedule: "0 6 * * MON",
        action: "lead_scoring",
      },
    ],
    tasks: [
      {
        id: "T-CJ-001",
        name: "Configure funnel tracking",
        description: "Set up multi-stage conversion funnel from visit through purchase",
        taskType: "configuration",
        assignedAgentId: "vw-cmo",
        priority: 0.85,
        estimatedDuration: "1h",
      },
      {
        id: "T-CJ-002",
        name: "Build retention segments",
        description: "Create segments for at-risk, loyal, and new customers",
        taskType: "analysis",
        assignedAgentId: "vw-cmo",
        priority: 0.8,
        estimatedDuration: "2h",
      },
    ],
  },
  {
    id: "WF-105",
    agentId: "vw-legal",
    name: "Compliance & Brand Safety",
    workflowType: "compliance",
    trigger: "scheduled",
    planId: "PLAN-CB-105",
    planName: "Compliance & Brand Safety Plan",
    goalId: "G-O005",
    schedule: "0 7 * * *",
    scheduleTimezone: "America/New_York",
    steps: [
      {
        id: "PS-CB-001",
        name: "Ad Review",
        stepType: "review",
        order: 1,
        estimatedDuration: "1h",
        schedule: "0 7 * * *",
        action: "ad_analytics",
      },
      {
        id: "PS-CB-002",
        name: "FTC/GDPR Check",
        stepType: "compliance",
        order: 2,
        estimatedDuration: "2h",
        schedule: "0 8 * * MON",
        action: "seo_audit",
      },
      {
        id: "PS-CB-003",
        name: "Brand Mentions",
        stepType: "monitoring",
        order: 3,
        estimatedDuration: "ongoing",
        schedule: "0 */2 * * *",
        action: "ad_analytics",
      },
      {
        id: "PS-CB-004",
        name: "Negative Scan",
        stepType: "monitoring",
        order: 4,
        estimatedDuration: "30m",
        schedule: "0 6 * * *",
        action: "ad_analytics",
      },
      {
        id: "PS-CB-005",
        name: "Report",
        stepType: "reporting",
        order: 5,
        estimatedDuration: "2h",
        schedule: "0 9 1 * *",
        action: "analytics_dashboard",
      },
    ],
    tasks: [
      {
        id: "T-CB-001",
        name: "Review active ad creatives",
        description: "Check all running ads for FTC compliance and brand guideline adherence",
        taskType: "review",
        assignedAgentId: "vw-legal",
        priority: 0.9,
        estimatedDuration: "2h",
      },
    ],
  },
  {
    id: "WF-106",
    agentId: "vw-cmo",
    name: "Content Lifecycle Management",
    workflowType: "marketing",
    trigger: "scheduled",
    planId: "PLAN-CL-106",
    planName: "Content Lifecycle Management Plan",
    goalId: "G-O012",
    schedule: "0 9 * * MON",
    scheduleTimezone: "America/New_York",
    steps: [
      {
        id: "PS-CL-001",
        name: "Ideation",
        stepType: "research",
        order: 1,
        estimatedDuration: "2h",
        schedule: "0 9 * * MON",
        action: "keyword_tracker",
      },
      {
        id: "PS-CL-002",
        name: "Creation",
        stepType: "creation",
        order: 2,
        estimatedDuration: "4h",
        schedule: "0 10 * * MON-FRI",
        action: "content_publish",
      },
      {
        id: "PS-CL-003",
        name: "Review",
        stepType: "review",
        order: 3,
        estimatedDuration: "1h",
        schedule: "0 14 * * WED,FRI",
        action: "seo_audit",
      },
      {
        id: "PS-CL-004",
        name: "Publishing",
        stepType: "execution",
        order: 4,
        estimatedDuration: "30m",
        schedule: "0 9 * * TUE,THU",
        action: "content_publish",
      },
      {
        id: "PS-CL-005",
        name: "Tracking",
        stepType: "monitoring",
        order: 5,
        estimatedDuration: "30m",
        schedule: "0 17 * * *",
        action: "analytics_dashboard",
      },
      {
        id: "PS-CL-006",
        name: "Archive",
        stepType: "maintenance",
        order: 6,
        estimatedDuration: "1h",
        schedule: "0 3 1 * *",
        action: "analytics_dashboard",
      },
    ],
    tasks: [
      {
        id: "T-CL-001",
        name: "Research trending topics",
        description: "Identify trending keywords and content gaps using keyword tracker",
        taskType: "research",
        assignedAgentId: "vw-cmo",
        priority: 0.8,
        estimatedDuration: "2h",
      },
      {
        id: "T-CL-002",
        name: "Create content calendar",
        description: "Plan monthly content across blog, social, and email channels",
        taskType: "planning",
        assignedAgentId: "vw-cmo",
        priority: 0.85,
        estimatedDuration: "3h",
      },
    ],
  },
  {
    id: "WF-107",
    agentId: "vw-cfo",
    name: "Marketing Budget Optimization",
    workflowType: "finance",
    trigger: "scheduled",
    planId: "PLAN-MB-107",
    planName: "Marketing Budget Optimization Plan",
    goalId: "G-T007",
    schedule: "0 8 * * MON",
    scheduleTimezone: "America/New_York",
    steps: [
      {
        id: "PS-MB-001",
        name: "Spend Aggregation",
        stepType: "data_collection",
        order: 1,
        estimatedDuration: "1h",
        schedule: "0 6 * * *",
        action: "ad_analytics",
      },
      {
        id: "PS-MB-002",
        name: "ROAS Analysis",
        stepType: "analysis",
        order: 2,
        estimatedDuration: "2h",
        schedule: "0 8 * * MON",
        action: "analytics_dashboard",
      },
      {
        id: "PS-MB-003",
        name: "Reallocation",
        stepType: "action",
        order: 3,
        estimatedDuration: "1h",
        schedule: "0 10 * * MON",
        action: "ad_campaign_manage",
      },
      {
        id: "PS-MB-004",
        name: "Forecast vs Actual",
        stepType: "reporting",
        order: 4,
        estimatedDuration: "2h",
        schedule: "0 9 1 * *",
        action: "analytics_dashboard",
      },
      {
        id: "PS-MB-005",
        name: "CFO Report",
        stepType: "deliverable",
        order: 5,
        estimatedDuration: "2h",
        schedule: "0 14 1 * *",
        action: "analytics_dashboard",
      },
    ],
    tasks: [
      {
        id: "T-MB-001",
        name: "Aggregate cross-platform spend",
        description: "Pull ad spend data from all platforms and calculate blended ROAS",
        taskType: "reporting",
        assignedAgentId: "vw-cfo",
        priority: 0.9,
        estimatedDuration: "1h",
      },
      {
        id: "T-MB-002",
        name: "Reallocate underperforming budgets",
        description: "Shift budget from low-ROAS to high-ROAS channels",
        taskType: "action",
        assignedAgentId: "vw-cfo",
        priority: 0.85,
        estimatedDuration: "1h",
      },
    ],
  },
  {
    id: "WF-108",
    agentId: "vw-cmo",
    name: "A/B Testing Framework",
    workflowType: "marketing",
    trigger: "scheduled",
    planId: "PLAN-AB-108",
    planName: "A/B Testing Framework Plan",
    goalId: "G-O005",
    schedule: "0 9 * * MON",
    scheduleTimezone: "America/New_York",
    steps: [
      {
        id: "PS-AB-001",
        name: "Hypothesis",
        stepType: "research",
        order: 1,
        estimatedDuration: "1h",
        schedule: "0 9 * * MON",
        action: "analytics_dashboard",
      },
      {
        id: "PS-AB-002",
        name: "Test Setup",
        stepType: "configuration",
        order: 2,
        estimatedDuration: "2h",
        schedule: "0 10 * * TUE",
        action: "email_campaign",
      },
      {
        id: "PS-AB-003",
        name: "Traffic Monitor",
        stepType: "monitoring",
        order: 3,
        estimatedDuration: "ongoing",
        schedule: "0 */6 * * *",
        action: "conversion_tracker",
      },
      {
        id: "PS-AB-004",
        name: "Significance Check",
        stepType: "analysis",
        order: 4,
        estimatedDuration: "1h",
        schedule: "0 9 * * FRI",
        action: "analytics_dashboard",
      },
      {
        id: "PS-AB-005",
        name: "Winner Deploy",
        stepType: "execution",
        order: 5,
        estimatedDuration: "1h",
        schedule: "0 10 * * MON",
        action: "ad_campaign_manage",
      },
    ],
    tasks: [
      {
        id: "T-AB-001",
        name: "Define test hypotheses",
        description:
          "Identify highest-impact variables to test across landing pages, ads, and emails",
        taskType: "research",
        assignedAgentId: "vw-cmo",
        priority: 0.8,
        estimatedDuration: "1h",
      },
      {
        id: "T-AB-002",
        name: "Create test variants",
        description: "Build A and B variants for the current test cycle",
        taskType: "creation",
        assignedAgentId: "vw-cmo",
        priority: 0.75,
        estimatedDuration: "2h",
      },
    ],
  },
  {
    id: "WF-109",
    agentId: "vw-ceo",
    name: "Crisis Management",
    workflowType: "operations",
    trigger: "scheduled",
    planId: "PLAN-CR-109",
    planName: "Crisis Management Plan",
    goalId: "G-O009",
    schedule: "*/15 * * * *",
    scheduleTimezone: "America/New_York",
    steps: [
      {
        id: "PS-CR-001",
        name: "Sentiment Monitor",
        stepType: "monitoring",
        order: 1,
        estimatedDuration: "ongoing",
        schedule: "*/15 * * * *",
        action: "ad_analytics",
      },
      {
        id: "PS-CR-002",
        name: "Alert Triage",
        stepType: "analysis",
        order: 2,
        estimatedDuration: "event-driven",
      },
      {
        id: "PS-CR-003",
        name: "Response Draft",
        stepType: "creation",
        order: 3,
        estimatedDuration: "event-driven",
      },
      {
        id: "PS-CR-004",
        name: "Stakeholder Notify",
        stepType: "communication",
        order: 4,
        estimatedDuration: "event-driven",
      },
      {
        id: "PS-CR-005",
        name: "Post-Crisis Review",
        stepType: "review",
        order: 5,
        estimatedDuration: "2h",
        schedule: "0 9 * * MON",
        action: "analytics_dashboard",
      },
    ],
    tasks: [
      {
        id: "T-CR-001",
        name: "Set up sentiment monitoring",
        description: "Configure brand mention and sentiment tracking across social platforms",
        taskType: "configuration",
        assignedAgentId: "vw-ceo",
        priority: 0.95,
        estimatedDuration: "1h",
      },
    ],
  },
  {
    id: "WF-110",
    agentId: "vw-coo",
    name: "Vendor & Partner Management",
    workflowType: "operations",
    trigger: "scheduled",
    planId: "PLAN-VP-110",
    planName: "Vendor & Partner Management Plan",
    goalId: "G-T014",
    schedule: "0 9 * * MON",
    scheduleTimezone: "America/New_York",
    steps: [
      {
        id: "PS-VP-001",
        name: "Pipeline Review",
        stepType: "review",
        order: 1,
        estimatedDuration: "1h",
        schedule: "0 9 * * MON",
        action: "crm_pipeline",
      },
      {
        id: "PS-VP-002",
        name: "Onboarding Check",
        stepType: "review",
        order: 2,
        estimatedDuration: "1h",
        schedule: "0 10 * * WED",
        action: "crm_pipeline",
      },
      {
        id: "PS-VP-003",
        name: "Scorecard",
        stepType: "reporting",
        order: 3,
        estimatedDuration: "2h",
        schedule: "0 9 1 * *",
        action: "analytics_dashboard",
      },
      {
        id: "PS-VP-004",
        name: "Renewal Alerts",
        stepType: "monitoring",
        order: 4,
        estimatedDuration: "30m",
        schedule: "0 8 1 * *",
        action: "crm_pipeline",
      },
      {
        id: "PS-VP-005",
        name: "Integration Health",
        stepType: "monitoring",
        order: 5,
        estimatedDuration: "30m",
        schedule: "0 3 * * *",
        action: "integration_sync",
      },
    ],
    tasks: [
      {
        id: "T-VP-001",
        name: "Review vendor pipeline",
        description:
          "Assess current vendor relationships and identify new partnership opportunities",
        taskType: "review",
        assignedAgentId: "vw-coo",
        priority: 0.8,
        estimatedDuration: "1h",
      },
      {
        id: "T-VP-002",
        name: "Check integration health",
        description: "Verify all vendor integrations are syncing correctly",
        taskType: "monitoring",
        assignedAgentId: "vw-coo",
        priority: 0.75,
        estimatedDuration: "30m",
      },
    ],
  },
];

// ── Tool Parameters ─────────────────────────────────────────────────────

const GoalSeedParams = Type.Object({
  business_id: Type.String({ description: "Business ID (e.g., 'vividwalls')" }),
  database: Type.Optional(
    Type.String({ description: "TypeDB database name (defaults to 'mabos')" }),
  ),
});

// ── Tool Factory ────────────────────────────────────────────────────────

export function createGoalSeedTools(_api: OpenClawPluginApi): AnyAgentTool[] {
  return [
    {
      name: "goal_seed_business",
      label: "Seed Business Goals",
      description:
        "Seed the TypeDB knowledge graph with VividWalls business goals, desires, and beliefs " +
        "from the BRD/financial model. Uses TOGAF 3-tier goal hierarchy with Tropos agent mapping.",
      parameters: GoalSeedParams,
      async execute(_id: string, params: Static<typeof GoalSeedParams>) {
        const client = getTypeDBClient();
        if (!client.isAvailable()) {
          const connected = await client.connect();
          if (!connected) {
            return textResult("TypeDB is not available. Start the server first.");
          }
        }

        const dbName = params.database || "mabos";
        const counts = {
          agents: 0,
          desires: 0,
          goals: 0,
          beliefs: 0,
          desire_goal_links: 0,
          belief_goal_links: 0,
          errors: [] as string[],
        };

        try {
          await client.ensureDatabase(dbName);
        } catch (e) {
          return textResult(
            `Failed to ensure database "${dbName}": ${e instanceof Error ? e.message : String(e)}`,
          );
        }

        // 1. Insert agents
        for (const agent of AGENTS) {
          try {
            await client.insertData(
              `insert $agent isa agent, has uid ${JSON.stringify(agent.id)}, has name ${JSON.stringify(agent.name)};`,
              dbName,
            );
            counts.agents++;
          } catch {
            // Agent may already exist
          }
        }

        // 2. Insert desires
        for (const d of DESIRES) {
          try {
            const typeql = DesireStoreQueries.createDesire(d.agentId, {
              id: d.id,
              name: d.name,
              description: d.description,
              priority: d.priority,
              importance: d.importance,
              urgency: d.urgency,
              alignment: d.alignment,
              category: d.category,
            });
            await client.insertData(typeql, dbName);
            counts.desires++;
          } catch (e) {
            counts.errors.push(`Desire ${d.id}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        // 3. Insert goals
        for (const g of GOALS) {
          try {
            const typeql = GoalStoreQueries.createGoal(g.agentId, {
              id: g.id,
              name: g.name,
              description: g.description,
              hierarchy_level: g.hierarchy_level,
              priority: g.priority,
              success_criteria: g.success_criteria,
              deadline: g.deadline,
              parent_goal_id: g.parent_goal_id,
              goal_type: g.goal_type,
            });
            await client.insertData(typeql, dbName);
            counts.goals++;
          } catch (e) {
            counts.errors.push(`Goal ${g.id}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        // 4. Link desires → goals
        for (const g of GOALS) {
          for (const desireId of g.desire_ids) {
            try {
              const typeql = GoalStoreQueries.linkDesireToGoal(g.agentId, desireId, g.id);
              await client.insertData(typeql, dbName);
              counts.desire_goal_links++;
            } catch (e) {
              counts.errors.push(
                `Link ${desireId}→${g.id}: ${e instanceof Error ? e.message : String(e)}`,
              );
            }
          }
        }

        // 5. Insert beliefs
        for (const b of BELIEFS) {
          try {
            const typeql = BeliefStoreQueries.createBelief(b.agentId, {
              id: b.id,
              category: b.category,
              certainty: b.certainty,
              subject: b.subject,
              content: b.content,
              source: b.source,
            });
            await client.insertData(typeql, dbName);
            counts.beliefs++;
          } catch (e) {
            counts.errors.push(`Belief ${b.id}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        // 6. Link beliefs → goals
        for (const b of BELIEFS) {
          for (const goalId of b.supports_goals) {
            try {
              const typeql = BeliefStoreQueries.linkBeliefToGoal(b.agentId, b.id, goalId);
              await client.insertData(typeql, dbName);
              counts.belief_goal_links++;
            } catch (e) {
              counts.errors.push(
                `Link ${b.id}→${goalId}: ${e instanceof Error ? e.message : String(e)}`,
              );
            }
          }
        }

        // 7. Insert preconditions
        let preconditionCount = 0;
        for (const pc of PRECONDITIONS) {
          try {
            const typeql = GoalStoreQueries.createPrecondition(pc.agentId, {
              id: pc.id,
              goalId: pc.goalId,
              name: pc.name,
              type: pc.type,
              expression: pc.expression,
              referencedGoalId: pc.referencedGoalId,
              satisfied: pc.satisfied,
            });
            await client.insertData(typeql, dbName);
            preconditionCount++;
          } catch (e) {
            counts.errors.push(
              `Precondition ${pc.id}: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }

        // 8. Insert delegations
        let delegationCount = 0;
        for (const del of DELEGATIONS) {
          for (const goalId of del.goalIds) {
            try {
              await client.insertData(
                GoalStoreQueries.createDelegation(del.from, del.to, goalId),
                dbName,
              );
              delegationCount++;
            } catch (e) {
              counts.errors.push(
                `Delegation ${del.from}→${del.to}/${goalId}: ${e instanceof Error ? e.message : String(e)}`,
              );
            }
          }
        }

        // 9. Insert decisions
        let decisionCount = 0;
        let decisionGoalLinks = 0;
        for (const d of DECISIONS) {
          try {
            const typeql = DecisionStoreQueries.createDecision(d.agentId, {
              id: d.id,
              name: d.name,
              description: d.description,
              urgency: d.urgency,
              options: JSON.stringify(d.options),
              recommendation: d.recommendation,
            });
            await client.insertData(typeql, dbName);
            decisionCount++;
          } catch (e) {
            counts.errors.push(`Decision ${d.id}: ${e instanceof Error ? e.message : String(e)}`);
          }

          // Link decisions to goals
          for (const goalId of d.goalIds) {
            try {
              const typeql = DecisionStoreQueries.linkDecisionToGoal(d.id, goalId);
              await client.insertData(typeql, dbName);
              decisionGoalLinks++;
            } catch (e) {
              counts.errors.push(
                `Link DEC ${d.id}→${goalId}: ${e instanceof Error ? e.message : String(e)}`,
              );
            }
          }
        }

        // 8. Insert workflows, plans, plan steps, and tasks
        let workflowCount = 0;
        let planCount = 0;
        let planStepCount = 0;
        let taskCount = 0;
        let goalPlanLinks = 0;
        let planStepLinks = 0;

        for (const wf of WORKFLOWS) {
          // Insert workflow
          try {
            const typeql = WorkflowStoreQueries.createWorkflow(wf.agentId, {
              id: wf.id,
              name: wf.name,
              workflowType: wf.workflowType,
              trigger: wf.trigger,
              cronExpression: wf.schedule,
              cronEnabled: wf.schedule ? true : undefined,
              cronTimezone: wf.scheduleTimezone,
            });
            await client.insertData(typeql, dbName);
            workflowCount++;
          } catch (e) {
            counts.errors.push(`Workflow ${wf.id}: ${e instanceof Error ? e.message : String(e)}`);
          }

          // Insert plan
          try {
            const now = new Date().toISOString();
            await client.insertData(
              `match $agent isa agent, has uid ${JSON.stringify(wf.agentId)};
insert $plan isa plan, has uid ${JSON.stringify(wf.planId)}, has name ${JSON.stringify(wf.planName)}, has description ${JSON.stringify(`Plan for ${wf.name}`)}, has plan_source "seed", has step_count ${wf.steps.length}, has confidence 0.8, has status "active", has created_at ${JSON.stringify(now)}, has updated_at ${JSON.stringify(now)}; (owner: $agent, owned: $plan) isa agent_owns;`,
              dbName,
            );
            planCount++;
          } catch (e) {
            counts.errors.push(`Plan ${wf.planId}: ${e instanceof Error ? e.message : String(e)}`);
          }

          // Link goal → plan
          try {
            const typeql = GoalStoreQueries.linkGoalToPlan(wf.agentId, wf.goalId, wf.planId);
            await client.insertData(typeql, dbName);
            goalPlanLinks++;
          } catch (e) {
            counts.errors.push(
              `Link ${wf.goalId}→${wf.planId}: ${e instanceof Error ? e.message : String(e)}`,
            );
          }

          // Insert plan steps
          for (const step of wf.steps) {
            try {
              const now = new Date().toISOString();
              const cronClause = step.schedule
                ? `, has cron_expression ${JSON.stringify(step.schedule)}, has cron_enabled true`
                : "";
              const toolClause = step.action
                ? `, has tool_binding ${JSON.stringify(step.action)}`
                : "";
              await client.insertData(
                `match $agent isa agent, has uid ${JSON.stringify(wf.agentId)};
insert $ps isa plan_step, has uid ${JSON.stringify(step.id)}, has name ${JSON.stringify(step.name)}, has step_type ${JSON.stringify(step.stepType)}, has estimated_duration ${JSON.stringify(step.estimatedDuration)}, has status "proposed", has sequence_order ${step.order}${cronClause}${toolClause}, has created_at ${JSON.stringify(now)}; (owner: $agent, owned: $ps) isa agent_owns;`,
                dbName,
              );
              planStepCount++;
            } catch (e) {
              counts.errors.push(`Step ${step.id}: ${e instanceof Error ? e.message : String(e)}`);
            }

            // Link plan → step
            try {
              await client.insertData(
                `match $plan isa plan, has uid ${JSON.stringify(wf.planId)}; $step isa plan_step, has uid ${JSON.stringify(step.id)};
insert (container: $plan, contained: $step) isa plan_contains_step;`,
                dbName,
              );
              planStepLinks++;
            } catch (e) {
              counts.errors.push(
                `Link ${wf.planId}→${step.id}: ${e instanceof Error ? e.message : String(e)}`,
              );
            }
          }

          // Insert tasks
          for (const task of wf.tasks) {
            try {
              const typeql = TaskStoreQueries.createTask(wf.agentId, {
                id: task.id,
                name: task.name,
                description: task.description,
                taskType: task.taskType,
                assignedAgentId: task.assignedAgentId,
                priority: task.priority,
                estimatedDuration: task.estimatedDuration,
                dependsOnIds: task.dependsOnIds,
              });
              await client.insertData(typeql, dbName);
              taskCount++;
            } catch (e) {
              counts.errors.push(`Task ${task.id}: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }

        const errorSummary =
          counts.errors.length > 0
            ? `\n\n### Errors (${counts.errors.length})\n${counts.errors
                .slice(0, 10)
                .map((e) => `- ${e}`)
                .join(
                  "\n",
                )}${counts.errors.length > 10 ? `\n- ... and ${counts.errors.length - 10} more` : ""}`
            : "";

        return textResult(`## VividWalls Knowledge Graph Seeded

**Database:** ${dbName}
**Business:** ${params.business_id}

### Entities Inserted
- Agents: ${counts.agents}/${AGENTS.length}
- Desires: ${counts.desires}/${DESIRES.length}
- Goals: ${counts.goals}/${GOALS.length} (${GOALS.filter((g) => g.hierarchy_level === "strategic").length} strategic, ${GOALS.filter((g) => g.hierarchy_level === "tactical").length} tactical, ${GOALS.filter((g) => g.hierarchy_level === "operational").length} operational)
- Beliefs: ${counts.beliefs}/${BELIEFS.length}
- Preconditions: ${preconditionCount}/${PRECONDITIONS.length}
- Delegations: ${delegationCount}/${DELEGATIONS.reduce((a, d) => a + d.goalIds.length, 0)}
- Decisions: ${decisionCount}/${DECISIONS.length}
- Workflows: ${workflowCount}/${WORKFLOWS.length}
- Plans: ${planCount}/${WORKFLOWS.length}
- Plan Steps: ${planStepCount}/${WORKFLOWS.reduce((a, w) => a + w.steps.length, 0)}
- Tasks: ${taskCount}/${WORKFLOWS.reduce((a, w) => a + w.tasks.length, 0)}

### Relations Created
- desire_motivates_goal: ${counts.desire_goal_links}
- belief_supports_goal: ${counts.belief_goal_links}
- goal_has_precondition: ${preconditionCount}
- goal_delegation: ${delegationCount}
- decision_resolves_goal: ${decisionGoalLinks}
- goal_requires_plan: ${goalPlanLinks}
- plan_contains_step: ${planStepLinks}${errorSummary}`);
      },
    },
  ];
}
