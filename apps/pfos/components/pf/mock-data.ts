import type { PfView } from "./sidebar";

export const NAV_ITEMS: { key: PfView; label: string; icon: string }[] = [
  { key: "mission", label: "Mission Control", icon: "MC" },
  { key: "workflows", label: "Workflows", icon: "WF" },
  { key: "timeline", label: "Timeline", icon: "TL" },
  { key: "operator", label: "Operator Brief", icon: "OB" },
  { key: "forge", label: "Agent Forge", icon: "AF" },
  { key: "pipeline", label: "Task Pipeline", icon: "TP" },
  { key: "vision", label: "Data Vision", icon: "DV" },
  { key: "cli", label: "Fang CLI", icon: "CLI" },
];

export type AgentKey = "analyst" | "builder" | "automator" | "commander";

export const AGENT_CATALOG: { key: AgentKey; name: string; desc: string; icon: string }[] = [
  { key: "analyst", name: "Fang Analyst", desc: "Research + insights generator", icon: "AN" },
  { key: "builder", name: "Fang Builder", desc: "Code + system construction", icon: "BL" },
  { key: "automator", name: "Fang Automator", desc: "Workflow execution + triggers", icon: "AU" },
  { key: "commander", name: "Fang Commander", desc: "Orchestration + mission planning", icon: "CM" },
];

export const DEFAULT_ACTIVE_AGENTS = [
  { name: "Fang Automator", desc: "Workflow execution + triggers", icon: "AU", status: "ONLINE" },
  { name: "Fang Analyst", desc: "Research + insights generator", icon: "AN", status: "ONLINE" },
  { name: "Fang Builder", desc: "Code + system construction", icon: "BL", status: "ONLINE" },
  { name: "Fang Commander", desc: "Orchestration + mission planning", icon: "CM", status: "ONLINE" },
] as const;

export const PIPELINE = ["Collect Data", "Analyze Market", "Generate Report", "Send Results"] as const;

export const NOTIFICATIONS = [
  { title: "Signal cluster detected", body: "Momentum aligns with low resistance zone", tag: "NEW" },
  { title: "Automation recommendation", body: "Route report output to email + webhook", tag: "NEW" },
  { title: "System health stable", body: "No agent conflicts detected", tag: "OK" },
] as const;
