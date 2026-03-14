import { mutation } from "./_generated/server";

export const seedAll = mutation({
  handler: async (ctx) => {
    const now = Date.now();
    const hour = 3600000;
    const day = 86400000;

    // Activities
    const activityData = [
      { type: "heartbeat", agentId: "jaum", title: "Jaum heartbeat check", description: "Pipeline HOLD awaiting approvals", timestamp: now - hour },
      { type: "task", agentId: "scout", title: "LinkedIn scrape completed", description: "0 new jobs matching criteria; total 13 in JOBS.md", timestamp: now - 3 * hour },
      { type: "approval", agentId: "apply", title: "Henry Schein FP&A approved", description: "Score 90/100, $225-250k remote. Submitting application.", timestamp: now - 5 * hour },
      { type: "system", title: "WhatsApp channel connected", description: "Gateway hiccup resolved, channel back online", timestamp: now - 8 * hour },
      { type: "deploy", agentId: "forge", title: "Dashboard v0.1 deployed", description: "Mission control dashboard live on localhost:3000", timestamp: now - day },
      { type: "content", agentId: "sage", title: "AGENTS.md updated", description: "Added job search pipeline documentation", timestamp: now - 2 * day },
      { type: "task", agentId: "matcher", title: "Zapier scored 79/100", description: "Director GTM Finance, $231-347k", timestamp: now - 3 * day },
      { type: "scrape", agentId: "scout", title: "HiringCafe scrape completed", description: "Found 13 listings matching criteria", timestamp: now - 4 * day },
    ];

    for (const a of activityData) {
      await ctx.db.insert("activities", a);
    }

    // Calendar events
    const weekStart = now - (new Date().getDay() * day);
    const calendarData = [
      { title: "Daily Standup", start: weekStart + 9 * hour, end: weekStart + 9.25 * hour, type: "meeting", color: "#6366f1" },
      { title: "Resume Review: Henry Schein", start: weekStart + day + 10 * hour, end: weekStart + day + 11 * hour, type: "task", color: "#10b981" },
      { title: "Scout Scrape Window", start: weekStart + day + 14 * hour, end: weekStart + day + 16 * hour, type: "automated", color: "#f59e0b" },
      { title: "Weekly Agent Review", start: weekStart + 2 * day + 15 * hour, end: weekStart + 2 * day + 16 * hour, type: "meeting", color: "#6366f1" },
      { title: "Application Deadline: Capital One", start: weekStart + 3 * day + 17 * hour, end: weekStart + 3 * day + 18 * hour, type: "deadline", color: "#ef4444" },
      { title: "Content Planning", start: weekStart + 4 * day + 11 * hour, end: weekStart + 4 * day + 12 * hour, type: "task", color: "#8b5cf6" },
    ];

    for (const e of calendarData) {
      await ctx.db.insert("calendarEvents", e);
    }

    // Ecosystem products
    const products = [
      { name: "OpenClaw", slug: "openclaw", status: "active", description: "Multi-channel AI gateway with extensible messaging integrations", health: "healthy", metrics: { agents: 13, channels: 5, uptime: 99.2 } },
      { name: "DashClaw", slug: "dashclaw", status: "active", description: "AI agent observability platform and command center", health: "healthy", metrics: { users: 1, views: 150 } },
      { name: "ClawdBot", slug: "clawdbot", status: "development", description: "Autonomous AI bot framework", health: "warning" },
      { name: "MoltBot", slug: "moltbot", status: "concept", description: "Multi-modal AI bot for content generation", health: "healthy" },
    ];

    for (const p of products) {
      await ctx.db.insert("ecosystemProducts", p);
    }

    return { seeded: true, activities: activityData.length, events: calendarData.length, products: products.length };
  },
});
