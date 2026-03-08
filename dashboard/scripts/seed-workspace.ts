/**
 * Seed workspace files for the dashboard
 * Run with: npx tsx scripts/seed-workspace.ts
 */
import fs from "fs/promises";
import path from "path";

const WORKSPACE = process.env.OPENCLAW_WORKSPACE_PATH || path.join(process.env.USERPROFILE || process.env.HOME || "", ".openclaw", "workspace");

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

async function writeFile(filePath: string, content: string) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, "utf-8");
  console.log(`  Created: ${filePath}`);
}

async function writeJson(filePath: string, data: unknown) {
  await writeFile(filePath, JSON.stringify(data, null, 2));
}

async function main() {
  console.log(`Seeding workspace at: ${WORKSPACE}\n`);

  // state/servers.json
  await writeJson(path.join(WORKSPACE, "state", "servers.json"), [
    {
      name: "OpenClaw Gateway",
      status: "up",
      port: 18789,
      lastCheck: new Date().toISOString(),
      details: "Local gateway on 127.0.0.1",
    },
    {
      name: "Mission Control",
      status: "up",
      port: 3000,
      lastCheck: new Date().toISOString(),
      details: "Next.js dashboard",
    },
    {
      name: "WhatsApp Channel",
      status: "up",
      lastCheck: new Date().toISOString(),
      details: "Connected via plugin",
    },
    {
      name: "Claude Max Proxy",
      status: "up",
      port: 3456,
      lastCheck: new Date().toISOString(),
      details: "Claude API proxy for Max subscription",
    },
  ]);

  // state/revenue.json
  await writeJson(path.join(WORKSPACE, "state", "revenue.json"), {
    current: 0,
    monthlyBurn: 120,
    net: -120,
    currency: "USD",
    breakdown: {
      xai: { name: "xAI API", monthly: 0, notes: "Free tier / zero-cost routing" },
      openrouter: { name: "OpenRouter", monthly: 20, notes: "Fallback routing" },
      infrastructure: { name: "Infrastructure", monthly: 100, notes: "Compute + storage" },
    },
  });

  // state/suggested-tasks.json
  await writeJson(path.join(WORKSPACE, "state", "suggested-tasks.json"), [
    {
      id: "task-001",
      category: "Revenue",
      title: "Set up Stripe integration for DashClaw",
      reasoning: "DashClaw could be monetized as an agent observability SaaS. Stripe is already a dependency.",
      nextAction: "Wire up subscription billing flow using existing Stripe dependency",
      priority: "high",
      effort: "medium",
      status: "pending",
    },
    {
      id: "task-002",
      category: "Product",
      title: "Add Discord channel integration",
      reasoning: "WhatsApp is live, Discord would expand reach to dev communities",
      nextAction: "Enable discord extension in openclaw.json plugins",
      priority: "medium",
      effort: "quick",
      status: "pending",
    },
    {
      id: "task-003",
      category: "Operations",
      title: "Automate daily backup of workspace files",
      reasoning: "Agent memory and state files are critical — OneDrive covers resumes but not workspace",
      nextAction: "Create a cron job to sync workspace/ to cloud storage",
      priority: "high",
      effort: "quick",
      status: "pending",
    },
    {
      id: "task-004",
      category: "Content",
      title: "Write launch blog post for OpenClaw",
      reasoning: "OpenClaw is mature enough for public announcement. Would drive community growth.",
      nextAction: "Draft blog post covering architecture and agent system",
      priority: "medium",
      effort: "medium",
      status: "pending",
    },
    {
      id: "task-005",
      category: "Community",
      title: "Create OpenClaw Discord server",
      reasoning: "Community channel needed for users and contributors",
      nextAction: "Set up server with channels: general, help, showcase, dev",
      priority: "low",
      effort: "quick",
      status: "pending",
    },
    {
      id: "task-006",
      category: "Operations",
      title: "Fix Scout Chrome attachment for LinkedIn scraping",
      reasoning: "Scout has been blocked on Chrome attachment since Feb 13 — high priority",
      nextAction: "Debug Chrome extension + OpenClaw browser attachment flow",
      priority: "critical",
      effort: "medium",
      status: "pending",
    },
  ]);

  // state/observations.md
  await writeFile(
    path.join(WORKSPACE, "state", "observations.md"),
    `# System Observations

## ${new Date().toISOString().split("T")[0]}

- Agent heartbeats running on 15-minute intervals across 13 agents
- WhatsApp channel stable — all messages routing through Jaum
- Scout blocked on Chrome attachment for LinkedIn scrape (since Feb 13)
- Resume review pipeline has accumulated overdue approvals
- xAI Grok 4.1 is the primary model with zero-cost API access
- Claude Max Proxy providing backup models via localhost:3456
- Memory system using daily markdown logs + SQLite databases

## Architecture Notes

- All agents share workspace at ~/.openclaw/workspace/
- Agent-specific workspaces at ~/.openclaw/workspace-{id}/
- Session transcripts stored as JSONL at ~/.openclaw/agents/{id}/sessions/
- Heartbeat protocol: 15min wake → read HEARTBEAT.md → act or HEARTBEAT_OK
`
  );

  // shared-context/priorities.md
  await writeFile(
    path.join(WORKSPACE, "shared-context", "priorities.md"),
    `# Current Priorities

1. **Resume Reviews** — Approve/reject pending resumes (Henry Schein 90, Zapier 79, US Bank 78)
2. **Scout Unblock** — Fix Chrome attachment for LinkedIn scraping
3. **Dashboard** — Mission Control dashboard build (this project)
4. **Job Pipeline** — Continue sourcing and matching new listings
5. **System Health** — Monitor agent heartbeats and gateway stability
`
  );

  // content/queue.md
  await writeFile(
    path.join(WORKSPACE, "content", "queue.md"),
    `# Content Queue

- **OpenClaw Architecture Deep Dive** [draft]
  Platform: Blog
  Overview of the multi-agent architecture, channel integrations, and heartbeat protocol.

- **Agent Squad: How 13 AIs Run My Job Search** [draft]
  Platform: LinkedIn
  Personal story about building an AI-powered job search pipeline.

- **Building a Mission Control Dashboard** [review]
  Platform: Twitter
  Thread about the Next.js + Convex + Tailwind v4 dashboard build.

- **OpenClaw v2026.2 Release Notes** [published]
  Platform: Blog
  Changelog and feature highlights for the latest release.
`
  );

  // clients/sample-client.md
  await writeFile(
    path.join(WORKSPACE, "clients", "acme-corp.md"),
    `# Acme Corp

Status: prospect
Contact: Jane Doe, CTO — jane@acme.example
Source: Referral from conference
Next Action: Schedule intro call
Notes: Interested in AI agent consulting for customer support automation.
`
  );

  // ecosystem/openclaw/overview.md
  await writeFile(
    path.join(WORKSPACE, "ecosystem", "openclaw", "overview.md"),
    `# OpenClaw

Multi-channel AI gateway with extensible messaging integrations.

## Key Facts
- 13 registered agents (Dev Team + Job Search Team)
- 40+ extension plugins
- Channels: WhatsApp, Telegram, Discord, Slack, Signal, iMessage, and more
- Running on Windows 10 Pro, gateway on port 18789
- Primary model: xAI Grok 4.1 Fast Reasoning (zero-cost)
- Fallback models: Claude Opus/Sonnet/Haiku via Max Proxy, GPT-5 Mini/Pro
`
  );

  await writeJson(path.join(WORKSPACE, "ecosystem", "openclaw", "metrics.json"), {
    agents: 13,
    extensions: 40,
    channels: 7,
    uptimePct: 99.2,
    sessionsTotal: 150,
  });

  console.log("\nDone! Workspace seeded successfully.");
}

main().catch(console.error);
