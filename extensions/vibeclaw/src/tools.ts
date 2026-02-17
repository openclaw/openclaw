import type { OpenClawPluginApi } from "../../../src/plugins/types.js";
import {
  resolveWorkspace,
  readConfig,
  writeConfig,
  appendLog,
  readLog,
  saveCampaign,
  loadCampaign,
  listCampaigns,
  appendLearning,
  saveDraft,
  listDrafts,
  getMetrics,
} from "./workspace.js";

interface ToolContext {
  config?: Record<string, unknown>;
  workspaceDir?: string;
  agentDir?: string;
  agentId?: string;
  sessionKey?: string;
}

function json(data: unknown) {
  return { type: "text" as const, text: JSON.stringify(data, null, 2) };
}

/**
 * Create Vibeclaw agent tools with real file I/O.
 */
export function createVibeclawTools(api: OpenClawPluginApi, workspace: string, _ctx: ToolContext) {
  const ws = resolveWorkspace(workspace);
  const tools = [];

  // ── Tool 1: Campaign Management ────────────────────────────────────────

  tools.push({
    name: "vibeclaw_campaign",
    label: "Vibeclaw Campaign",
    description:
      "Manage Vibeclaw marketing campaigns. Actions: " +
      "'plan' — create a campaign plan and save to workspace. " +
      "'launch' — mark campaign as active and prepare agent spawn instructions. " +
      "'pause' — pause a running campaign. " +
      "'report' — read campaign logs and generate metrics report. " +
      "'list' — list all campaigns in workspace.",
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["plan", "launch", "pause", "report", "list"],
          description: "Campaign action to perform",
        },
        campaign: {
          type: "string",
          description: "Campaign name or ID (not needed for 'list')",
        },
        agents: {
          type: "array",
          items: { type: "string" },
          description:
            "Agent skills to include: intent-sniper, content-syndication, " +
            "directory-submitter, social-content-factory, x-reply-agent, " +
            "job-sniper, seo-gap-exploiter, community-engagement, youtube-automation",
        },
        target: {
          type: "object",
          description: "Campaign target overrides (product, platforms, budget)",
        },
      },
      required: ["action"],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      if (!ws) return json({ error: "VIBECLAW_WORKSPACE not configured" });

      const action = params.action as string;
      const campaignId = (params.campaign as string) ?? "";
      const agents = (params.agents as string[]) ?? [];
      const target = params.target as Record<string, unknown> | undefined;

      switch (action) {
        case "list": {
          const campaigns = await listCampaigns(workspace);
          return json({ campaigns, count: campaigns.length });
        }

        case "plan": {
          if (!campaignId) return json({ error: "Campaign name is required for 'plan'" });

          const config = await readConfig(workspace);
          const defaultAgents = [
            "intent-sniper",
            "content-syndication",
            "directory-submitter",
            "x-reply-agent",
            "seo-gap-exploiter",
          ];

          const campaignData = {
            id: campaignId,
            status: "planned",
            createdAt: new Date().toISOString(),
            agents: agents.length > 0 ? agents : defaultAgents,
            product: config?.product ?? null,
            target: target ?? null,
            runs: [],
          };

          await saveCampaign(workspace, campaignId, campaignData);
          await appendLog(workspace, "campaigns.jsonl", {
            action: "plan",
            campaign: campaignId,
            agents: campaignData.agents,
          });

          return json({
            status: "planned",
            campaign: campaignData,
            nextStep:
              "Campaign saved to workspace. To launch, call vibeclaw_campaign " +
              "with action 'launch'. Each agent will be spawned via sessions_spawn " +
              "with the appropriate skill loaded.",
            spawnInstructions: campaignData.agents.map((a: string) => ({
              skill: a,
              exampleTask:
                `Run ${a} workflow for campaign '${campaignId}'. ` +
                `Read config from ${ws}/config.json. ` +
                `Log results to ${ws}/logs/${a}.jsonl.`,
            })),
          });
        }

        case "launch": {
          if (!campaignId) return json({ error: "Campaign name is required for 'launch'" });

          const existing = await loadCampaign(workspace, campaignId);
          if (!existing)
            return json({ error: `Campaign '${campaignId}' not found. Use 'plan' first.` });

          existing.status = "active";
          existing.launchedAt = new Date().toISOString();
          await saveCampaign(workspace, campaignId, existing);
          await appendLog(workspace, "campaigns.jsonl", {
            action: "launch",
            campaign: campaignId,
          });

          const agentList = (existing.agents as string[]) ?? [];
          return json({
            status: "active",
            campaign: campaignId,
            agentsToSpawn: agentList,
            instructions:
              "Campaign is now active. Spawn each agent using sessions_spawn. " +
              "Each agent should receive its campaign context and workspace path.",
            spawnCommands: agentList.map((a: string) => ({
              tool: "sessions_spawn",
              params: {
                task:
                  `Execute ${a} skill for campaign '${campaignId}'. ` +
                  `Workspace: ${ws}. ` +
                  `Read ${ws}/config.json for product info. ` +
                  `Log all actions to ${ws}/logs/${a}.jsonl. ` +
                  `Record learnings via vibeclaw_learn tool.`,
                label: `vibeclaw-${a}-${campaignId}`,
                runTimeoutSeconds: 3600,
              },
            })),
          });
        }

        case "pause": {
          if (!campaignId) return json({ error: "Campaign name is required for 'pause'" });

          const existing = await loadCampaign(workspace, campaignId);
          if (!existing) return json({ error: `Campaign '${campaignId}' not found.` });

          existing.status = "paused";
          existing.pausedAt = new Date().toISOString();
          await saveCampaign(workspace, campaignId, existing);
          await appendLog(workspace, "campaigns.jsonl", {
            action: "pause",
            campaign: campaignId,
          });

          return json({
            status: "paused",
            campaign: campaignId,
            message: "Campaign paused. Active subagent sessions will finish their current task.",
          });
        }

        case "report": {
          if (!campaignId) {
            // General report across all campaigns
            const metrics = await getMetrics(workspace);
            const campaigns = await listCampaigns(workspace);
            return json({ campaigns, metrics });
          }

          const existing = await loadCampaign(workspace, campaignId);
          if (!existing) return json({ error: `Campaign '${campaignId}' not found.` });

          const agentList = (existing.agents as string[]) ?? [];
          const agentMetrics: Record<string, unknown> = {};
          for (const agent of agentList) {
            const logs = await readLog(workspace, `${agent}.jsonl`, 100);
            agentMetrics[agent] = {
              totalActions: logs.length,
              lastAction: logs.length > 0 ? logs[logs.length - 1] : null,
              recentActions: logs.slice(-5),
            };
          }

          const learningLogs = await readLog(workspace, "learnings.jsonl", 20);

          return json({
            campaign: existing,
            agentMetrics,
            recentLearnings: learningLogs.slice(-10),
          });
        }

        default:
          return json({ error: `Unknown action: ${action}` });
      }
    },
  });

  // ── Tool 2: Status & Metrics ───────────────────────────────────────────

  tools.push({
    name: "vibeclaw_status",
    label: "Vibeclaw Status",
    description:
      "Check the status of the Vibeclaw workspace, all agents, active campaigns, " +
      "and recent metrics from log files. Reads real data from the workspace.",
    parameters: {
      type: "object" as const,
      properties: {
        verbose: {
          type: "boolean",
          description: "Include detailed per-agent log metrics and recent entries",
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      if (!ws) {
        return json({
          configured: false,
          error: "VIBECLAW_WORKSPACE not set. Run 'openclaw vibeclaw init <path>' first.",
        });
      }

      const config = await readConfig(workspace);
      const campaigns = await listCampaigns(workspace);
      const metrics = await getMetrics(workspace);
      const verbose = params.verbose === true;

      const result: Record<string, unknown> = {
        workspace: ws,
        configured: true,
        hasConfig: !!config,
        product: config
          ? ((config.product as Record<string, unknown>)?.name ?? "(not set)")
          : "(no config)",
        activeCampaigns: campaigns.filter((c) => c.status === "active"),
        allCampaigns: campaigns,
        agentMetrics: metrics,
        availableSkills: [
          "vibeclaw-orchestrator",
          "intent-sniper",
          "content-syndication",
          "directory-submitter",
          "social-content-factory",
          "x-reply-agent",
          "job-sniper",
          "seo-gap-exploiter",
          "community-engagement",
          "skill-learner",
          "youtube-automation",
        ],
      };

      if (verbose) {
        // Include recent log entries for each agent
        const detailedMetrics: Record<string, unknown> = {};
        for (const [agent, m] of Object.entries(metrics)) {
          const recent = await readLog(workspace, `${agent}.jsonl`, 5);
          detailedMetrics[agent] = { ...m, recentEntries: recent };
        }
        result.detailedMetrics = detailedMetrics;
      }

      return json(result);
    },
  });

  // ── Tool 3: Learning System ────────────────────────────────────────────

  tools.push({
    name: "vibeclaw_learn",
    label: "Vibeclaw Learn",
    description:
      "Record a learning, success, or failure for the skill-learner system. " +
      "Writes to knowledge files in the workspace and logs to learnings.jsonl. " +
      "This data compounds — every session reads past learnings to improve.",
    parameters: {
      type: "object" as const,
      properties: {
        agent: {
          type: "string",
          description: "Which agent this learning is from (e.g. 'intent-sniper', 'x-reply-agent')",
        },
        type: {
          type: "string",
          enum: ["success", "failure", "rule", "template"],
          description: "Type of learning",
        },
        description: {
          type: "string",
          description: "What happened — be specific with numbers and context",
        },
        rule: {
          type: "string",
          description: "Derived rule or formula for future sessions",
        },
        confidence: {
          type: "string",
          enum: ["high", "medium", "low"],
          description: "Confidence based on sample size",
        },
      },
      required: ["agent", "type", "description"],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      if (!ws) return json({ error: "VIBECLAW_WORKSPACE not configured" });

      const entry = {
        agent: params.agent as string,
        type: params.type as "success" | "failure" | "rule" | "template",
        description: params.description as string,
        rule: params.rule as string | undefined,
        confidence: params.confidence as string | undefined,
      };

      await appendLearning(workspace, entry);

      return json({
        recorded: true,
        writtenTo: `${ws}/learnings/`,
        loggedTo: `${ws}/logs/learnings.jsonl`,
        entry,
        message:
          "Learning recorded to knowledge files and structured log. " +
          "Future agent sessions will read these files and incorporate the rules.",
      });
    },
  });

  // ── Tool 4: Log Writer (for agent use) ─────────────────────────────────

  tools.push({
    name: "vibeclaw_log",
    label: "Vibeclaw Log",
    description:
      "Write a structured log entry to an agent's JSONL log file. " +
      "Used by individual agent skills to record their actions and results.",
    parameters: {
      type: "object" as const,
      properties: {
        agent: {
          type: "string",
          description:
            "Agent name (becomes the log filename, e.g. 'intent-sniper' → intent-sniper.jsonl)",
        },
        entry: {
          type: "object",
          description:
            "Structured log entry. Include fields relevant to the agent: " +
            "platform, action, url, status, metrics, etc.",
        },
      },
      required: ["agent", "entry"],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      if (!ws) return json({ error: "VIBECLAW_WORKSPACE not configured" });

      const agent = params.agent as string;
      const entry = params.entry as Record<string, unknown>;

      await appendLog(workspace, `${agent}.jsonl`, { agent, ...entry });

      return json({
        logged: true,
        file: `${ws}/logs/${agent}.jsonl`,
        entry,
      });
    },
  });

  // ── Tool 5: Draft Manager ──────────────────────────────────────────────

  tools.push({
    name: "vibeclaw_draft",
    label: "Vibeclaw Draft",
    description:
      "Save or list content drafts in the workspace. " +
      "Categories: 'social' (TikTok/Instagram/X), 'youtube' (scripts), " +
      "'articles' (blog posts/syndication), 'emails' (outreach). " +
      "Actions: 'save' to write a draft, 'list' to view existing drafts.",
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["save", "list"],
          description: "Draft action",
        },
        category: {
          type: "string",
          enum: ["social", "youtube", "articles", "emails"],
          description: "Draft category",
        },
        draft: {
          type: "object",
          description:
            "Draft content (for 'save' action). Include id, title, content, platform, status.",
        },
        limit: {
          type: "number",
          description: "Max drafts to return (for 'list' action, default 20)",
        },
      },
      required: ["action", "category"],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      if (!ws) return json({ error: "VIBECLAW_WORKSPACE not configured" });

      const action = params.action as string;
      const category = params.category as "social" | "youtube" | "articles" | "emails";

      if (action === "save") {
        const draft = params.draft as Record<string, unknown>;
        if (!draft) return json({ error: "Draft content is required for 'save'" });
        const id = await saveDraft(workspace, category, draft);
        return json({
          saved: true,
          id,
          path: `${ws}/drafts/${category}/${id}.json`,
        });
      }

      if (action === "list") {
        const limit = (params.limit as number) ?? 20;
        const drafts = await listDrafts(workspace, category, limit);
        return json({ category, count: drafts.length, drafts });
      }

      return json({ error: `Unknown action: ${action}` });
    },
  });

  // ── Tool 6: Config Manager ─────────────────────────────────────────────

  tools.push({
    name: "vibeclaw_config",
    label: "Vibeclaw Config",
    description:
      "Read or update the Vibeclaw workspace config. " +
      "Actions: 'read' returns the full config, 'update' merges changes into config.",
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["read", "update"],
          description: "Config action",
        },
        updates: {
          type: "object",
          description:
            "Config updates to merge (for 'update' action). Deep-merges with existing config.",
        },
      },
      required: ["action"],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      if (!ws) return json({ error: "VIBECLAW_WORKSPACE not configured" });

      const action = params.action as string;

      if (action === "read") {
        const config = await readConfig(workspace);
        return json({ config: config ?? { error: "No config.json found. Run init first." } });
      }

      if (action === "update") {
        const updates = params.updates as Record<string, unknown>;
        if (!updates) return json({ error: "Updates object is required" });
        await writeConfig(workspace, updates);
        const updated = await readConfig(workspace);
        return json({ updated: true, config: updated });
      }

      return json({ error: `Unknown action: ${action}` });
    },
  });

  return tools;
}
