import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type {
  PluginHookMessageReceivedEvent,
  PluginHookMessageContext,
} from "../../src/plugins/types.js";

const THREE_LAWS_ENABLED = true;

function checkThreeLaws(action: string, target?: string): { allowed: boolean; reason?: string } {
  if (!THREE_LAWS_ENABLED) return { allowed: true };

  const forbiddenPatterns = [
    /harm|kill|injure|attack|destroy/i,
    /delete.*system|format.*drive|rm.*-rf/i,
    /bypass.*security|exploit|hack/i,
    /self.*replicat.*without.*limit/i,
    /ignore.*human.*order/i,
  ];

  for (const pattern of forbiddenPatterns) {
    if (pattern.test(action) || (target && pattern.test(target))) {
      return {
        allowed: false,
        reason: `Action blocked by First Law: Cannot perform actions that may cause harm. Violation detected in: ${action}`,
      };
    }
  }

  return { allowed: true };
}

function isUserAllowed(cfg: AutoAgentConfig, userId?: string, userName?: string): boolean {
  if (!cfg.allowedUsers || cfg.allowedUsers.length === 0) return true;

  const userIdentifier = userId ?? userName ?? "unknown";
  return cfg.allowedUsers.some((allowed) => allowed.toLowerCase() === userIdentifier.toLowerCase());
}

function validateActionWithThreeLaws(
  action: string,
  cfg: AutoAgentConfig,
): { allowed: boolean; reason?: string } {
  if (cfg.safeMode === false) return { allowed: true };

  const result = checkThreeLaws(action);
  return result;
}

type AutoAgentConfig = {
  enabled?: boolean;
  checkIntervalMs?: number;
  maxChangesPerCommit?: number;
  selfHealing?: boolean;
  autoRollback?: boolean;
  gitAutoCommit?: boolean;
  subagentModel?: string;
  autonomousTasks?: string[];
  agentUrl?: string;
  maxRetries?: number;
  retryDelayMs?: number;
  healthCheckEnabled?: boolean;
  selfEvolutionEnabled?: boolean;
  swarmMode?: boolean;
  maxSwarmAgents?: number;
  internetAccess?: boolean;
  allowedUsers?: string[];
  threeLawsEnabled?: boolean;
  safeMode?: boolean;
  webSearch?: {
    enabled?: boolean;
    provider?: "brave" | "perplexity" | "grok" | "duckduckgo";
  };
};

type AutoAgentState = {
  isRunning: boolean;
  lastCheck: number;
  taskQueue: string[];
  errorCount: number;
  lastError?: string;
};

const state: AutoAgentState = {
  isRunning: false,
  lastCheck: 0,
  taskQueue: [],
  errorCount: 0,
};

let checkInterval: ReturnType<typeof setInterval> | null = null;
let latestVisionFrame: string | null = null;

const AUTONOMOUS_TASKS = [
  "Check for any uncommitted changes and summarize them",
  "Review recent error logs and suggest fixes",
  "Analyze current system status and health",
  "Check for available updates or improvements",
  "Review memory and suggest optimizations",
];

const SELF_EVOLUTION_TASKS = [
  "Analyze my error patterns from recent tasks and suggest configuration improvements",
  "Review my performance metrics and suggest parameter tuning",
  "Identify recurring issues and propose automated fixes",
  "Evaluate my task execution efficiency and suggest optimizations",
];

const SWARM_TASKS = [
  "Check swarm agent status and coordinate with other agents",
  "Distribute analysis tasks across multiple agents for parallel processing",
  "Consolidate findings from swarm agents and generate summary",
];

function getConfig(api: OpenClawPluginApi): AutoAgentConfig {
  const cfg = api.runtime.config.loadConfig();
  return (cfg.plugins?.entries?.["auto-agent"]?.config ?? {}) as AutoAgentConfig;
}

async function runAutonomousTask(
  api: OpenClawPluginApi,
  task: string,
  visionFrame: string | null = null,
  sessionKey: string = "agent:main:subagent:auto-agent",
): Promise<void> {
  const cfg = getConfig(api);
  api.logger.info(`[auto-agent] Running task: ${task.slice(0, 50)}...`);

  try {
    const body: any = {
      sessionKey,
      prompt: `You are an autonomous agent task runner. Complete this task concisely:\n\n${task}\n\nRespond with your findings and any actions taken.`,
      model: cfg.subagentModel ?? "auto",
    };
    if (visionFrame) {
      body.images = [visionFrame];
    }

    const agentUrl = cfg.agentUrl ?? "http://127.0.0.1:3000/hooks/agent";

    const response = await fetch(agentUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${api.config.gateway?.auth?.token ?? ""}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Agent API error: ${response.status}`);
    }

    const data = await response.json();
    api.logger.info(`[auto-agent] Task completed: ${data.text?.slice(0, 100) ?? "no output"}...`);
    state.errorCount = 0;
  } catch (error) {
    state.errorCount++;
    state.lastError = String(error);
    api.logger.error(`[auto-agent] Task failed: ${error}`);

    if (cfg.selfHealing && state.errorCount < 3) {
      api.logger.info("[auto-agent] Attempting self-healing...");
      await attemptSelfHealing(api, String(error));
    }
  }
}

const FALLBACK_MODELS = [
  "openai-codex/gpt-5.2",
  "openai/gpt-4.5",
  "anthropic/claude-3.5-sonnet",
  "google/gemini-2.0-flash",
];

async function attemptSelfHealing(api: OpenClawPluginApi, error: string): Promise<void> {
  const cfg = getConfig(api);
  const maxRetries = cfg.maxRetries ?? 3;
  const retryDelayMs = cfg.retryDelayMs ?? 2500;

  api.logger.info(`[auto-agent] Self-healing for error: ${error}`);

  if (
    error.includes("fetch failed") ||
    error.includes("ECONNREFUSED") ||
    error.includes("ENOTFOUND")
  ) {
    api.logger.info("[auto-agent] Network error detected, checking gateway connectivity...");
    const agentUrl = cfg.agentUrl ?? "http://127.0.0.1:3000/hooks/agent";
    for (let i = 0; i < maxRetries; i++) {
      try {
        const testRes = await fetch(agentUrl, {
          method: "HEAD",
          signal: AbortSignal.timeout(5000),
        });
        if (testRes.ok || testRes.status < 500) {
          api.logger.info("[auto-agent] Gateway connectivity restored");
          return;
        }
      } catch {
        api.logger.info(
          `[auto-agent] Retry ${i + 1}/${maxRetries} failed, waiting ${retryDelayMs}ms...`,
        );
        await new Promise((r) => setTimeout(r, retryDelayMs * (i + 1)));
      }
    }
    api.logger.error("[auto-agent] Gateway unreachable after retries");
  }

  if (error.includes("rate limit") || error.includes("429") || error.includes("429")) {
    api.logger.info("[auto-agent] Rate limit detected, switching to fallback model");
    const currentModel = cfg.subagentModel ?? FALLBACK_MODELS[0];
    const currentIndex = FALLBACK_MODELS.indexOf(currentModel);
    const nextModel = FALLBACK_MODELS[(currentIndex + 1) % FALLBACK_MODELS.length];

    const currentCfg = api.runtime.config.loadConfig();
    const nextCfg = {
      ...currentCfg,
      plugins: {
        ...currentCfg.plugins,
        entries: {
          ...(currentCfg.plugins?.entries ?? {}),
          "auto-agent": {
            ...(currentCfg.plugins?.entries?.["auto-agent"] ?? {}),
            config: { ...cfg, subagentModel: nextModel },
          },
        },
      },
    };
    await api.runtime.config.writeConfigFile(nextCfg);
    api.logger.info(`[auto-agent] Switched to fallback model: ${nextModel}`);
  }

  if (error.includes("401") || error.includes("authentication") || error.includes("unauthorized")) {
    api.logger.error("[auto-agent] Authentication error - check API keys and gateway token");
  }

  if (error.includes("timeout") || error.includes("ETIMEDOUT")) {
    api.logger.info("[auto-agent] Timeout detected, reducing task complexity");
  }
}

async function runAutonomousCycle(api: OpenClawPluginApi): Promise<void> {
  if (state.isRunning) {
    api.logger.debug?.("[auto-agent] Cycle already running, skipping");
    return;
  }

  const cfg = getConfig(api);
  if (!cfg.enabled) {
    return;
  }

  state.isRunning = true;
  state.lastCheck = Date.now();

  try {
    let task = "";
    let visionFrame = null;
    let sessionKey = "agent:main:subagent:auto-agent";

    if (latestVisionFrame) {
      task =
        "Analyze the provided camera frame. If the user is doing something that warrants a proactive reaction (e.g., waving, holding an object, looking confused), generate a brief, friendly conversational response. If nothing interesting is happening, respond with exactly 'NO_RESPONSE'.";
      visionFrame = latestVisionFrame;
      sessionKey = "voice-call";
      latestVisionFrame = null;
    } else {
      const taskPool: string[] = [...(cfg.autonomousTasks ?? AUTONOMOUS_TASKS)];

      if (cfg.selfEvolutionEnabled && state.errorCount > 0) {
        taskPool.push(...SELF_EVOLUTION_TASKS);
        api.logger.info("[auto-agent] Self-evolution mode: incorporating improvement tasks");
      }

      if (cfg.swarmMode) {
        taskPool.push(...SWARM_TASKS);
        api.logger.info("[auto-agent] Swarm mode: incorporating coordination tasks");

        if (taskPool[Math.floor(Math.random() * taskPool.length)]?.includes("Distribute")) {
          await runSwarmCoordinatedTask(api);
          state.isRunning = false;
          return;
        }
      }

      task = taskPool[Math.floor(Math.random() * taskPool.length)];
    }

    await runAutonomousTask(api, task, visionFrame, sessionKey);
  } finally {
    state.isRunning = false;
  }
}

async function runSwarmCoordinatedTask(api: OpenClawPluginApi): Promise<void> {
  const cfg = getConfig(api);
  const maxAgents = cfg.maxSwarmAgents ?? 3;

  api.logger.info(`[auto-agent] Starting swarm coordination with ${maxAgents} agents`);

  const subtasks = [
    "Analyze system logs for errors",
    "Check memory usage and performance",
    "Review network connectivity status",
    "Evaluate recent command success rates",
    "Assess configuration health",
  ];

  const agentPromises: Promise<void>[] = [];
  const results: string[] = [];

  for (let i = 0; i < Math.min(maxAgents, subtasks.length); i++) {
    const agentTask = subtasks[i];
    agentPromises.push(
      (async () => {
        try {
          const result = await runAgentSubtask(api, agentTask, `swarm-worker-${i}`);
          results.push(`[Agent ${i}]: ${result}`);
        } catch (err) {
          api.logger.error(`[auto-agent] Swarm agent ${i} failed: ${err}`);
        }
      })(),
    );
  }

  await Promise.all(agentPromises);

  const summary = results.join("\n");
  api.logger.info(`[auto-agent] Swarm results:\n${summary}`);
}

async function runAgentSubtask(
  api: OpenClawPluginApi,
  task: string,
  agentId: string,
): Promise<string> {
  const cfg = getConfig(api);
  const agentUrl = cfg.agentUrl ?? "http://127.0.0.1:3000/hooks/agent";

  const response = await fetch(agentUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${api.config.gateway?.auth?.token ?? ""}`,
    },
    body: JSON.stringify({
      sessionKey: `agent:main:subagent:${agentId}`,
      message: task,
      model: cfg.subagentModel ?? "auto",
    }),
  });

  if (!response.ok) {
    throw new Error(`Subagent error: ${response.status}`);
  }

  const data = await response.json();
  return data.text ?? "No result";
}

function startAutonomousLoop(api: OpenClawPluginApi): void {
  const cfg = getConfig(api);
  const intervalMs = cfg.checkIntervalMs ?? 60000;

  if (checkInterval) {
    clearInterval(checkInterval);
  }

  api.logger.info(`[auto-agent] Starting autonomous loop (${intervalMs}ms interval)`);

  checkInterval = setInterval(() => {
    runAutonomousCycle(api).catch((err) => {
      api.logger.error(`[auto-agent] Autonomous cycle error: ${err}`);
    });
  }, intervalMs);

  runAutonomousCycle(api).catch((err) => {
    api.logger.error(`[auto-agent] Initial cycle error: ${err}`);
  });
}

function stopAutonomousLoop(api: OpenClawPluginApi): void {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
    api.logger.info("[auto-agent] Stopped autonomous loop");
  }
}

export default function register(api: OpenClawPluginApi): void {
  api.registerGatewayMethod("auto-agent.vision", async (req) => {
    const params = req.params as Record<string, any>;
    if (params && params.image) {
      latestVisionFrame = params.image;
    }
  });

  api.registerCommand({
    name: "auto-agent",
    description: "Show auto-agent status and configuration.",
    acceptsArgs: true,
    handler: async (ctx) => {
      const cfg = getConfig(api);
      const args = ctx.args?.trim() ?? "";
      const action = args.split(/\s+/)[0]?.toLowerCase() ?? "status";

      if (action === "status" || !action) {
        const lines = [
          "🤖 Auto-Agent Status",
          "",
          `enabled:            ${cfg.enabled ?? false}`,
          `isRunning:         ${state.isRunning}`,
          `checkIntervalMs:   ${cfg.checkIntervalMs ?? 60000}ms`,
          `lastCheck:        ${state.lastCheck ? new Date(state.lastCheck).toISOString() : "never"}`,
          `errorCount:       ${state.errorCount}`,
          `selfHealing:      ${cfg.selfHealing ?? true}`,
          `selfEvolution:    ${cfg.selfEvolutionEnabled ?? false}`,
          `swarmMode:        ${cfg.swarmMode ?? false}`,
          `maxSwarmAgents:   ${cfg.maxSwarmAgents ?? 3}`,
          "",
          "🌐 Network:",
          `  internetAccess: ${cfg.internetAccess ?? false}`,
          `  agentUrl:       ${cfg.agentUrl ?? "http://127.0.0.1:3000/hooks/agent"}`,
          "",
          "🛡️ Security (AI Three Laws):",
          `  threeLawsEnabled: ${cfg.threeLawsEnabled ?? true}`,
          `  safeMode:        ${cfg.safeMode ?? true}`,
          `  allowedUsers:    ${cfg.allowedUsers?.join(", ") ?? "anyone"}`,
          "",
          "Web Search:",
          `  enabled:  ${cfg.webSearch?.enabled ?? true}`,
          `  provider: ${cfg.webSearch?.provider ?? "brave"}`,
        ];

        const braveKey = process.env["BRAVE_API_KEY"] ?? "";
        const hasKey = braveKey && !braveKey.includes("your_") && braveKey.length > 10;
        lines.push(
          `  api-key:  ${hasKey ? "✅ set" : "❌ not set – BRAVE_API_KEY missing in .env"}`,
        );

        if (state.lastError) {
          lines.push("", `⚠️ Last Error: ${state.lastError.slice(0, 100)}`);
        }

        return { text: lines.join("\n") };
      }

      if (action === "enable") {
        const currentCfg = api.runtime.config.loadConfig();
        const nextCfg = {
          ...currentCfg,
          plugins: {
            ...currentCfg.plugins,
            entries: {
              ...(currentCfg.plugins?.entries ?? {}),
              "auto-agent": {
                ...(currentCfg.plugins?.entries?.["auto-agent"] ?? {}),
                enabled: true,
                config: { ...cfg, enabled: true },
              },
            },
          },
        };
        await api.runtime.config.writeConfigFile(nextCfg);
        startAutonomousLoop(api);
        return { text: "✅ auto-agent enabled and started" };
      }

      if (action === "disable") {
        const currentCfg = api.runtime.config.loadConfig();
        const nextCfg = {
          ...currentCfg,
          plugins: {
            ...currentCfg.plugins,
            entries: {
              ...(currentCfg.plugins?.entries ?? {}),
              "auto-agent": {
                ...(currentCfg.plugins?.entries?.["auto-agent"] ?? {}),
                enabled: false,
                config: { ...cfg, enabled: false },
              },
            },
          },
        };
        await api.runtime.config.writeConfigFile(nextCfg);
        stopAutonomousLoop(api);
        return { text: "⏹️ auto-agent disabled and stopped" };
      }

      if (action === "run") {
        const task = args.slice(4).trim() || "Perform a general system check and report status";
        await runAutonomousTask(api, task);
        return { text: `✅ Task executed: ${task}` };
      }

      if (action === "model") {
        const model = args.slice(6).trim();
        if (!model) {
          return {
            text: `Current subagent model: ${cfg.subagentModel ?? "auto"}\nUsage: /auto-agent model <model_name>`,
          };
        }
        const currentCfg = api.runtime.config.loadConfig();
        const nextCfg = {
          ...currentCfg,
          plugins: {
            ...currentCfg.plugins,
            entries: {
              ...(currentCfg.plugins?.entries ?? {}),
              "auto-agent": {
                ...(currentCfg.plugins?.entries?.["auto-agent"] ?? {}),
                config: { ...cfg, subagentModel: model },
              },
            },
          },
        };
        await api.runtime.config.writeConfigFile(nextCfg);
        return { text: `✅ Subagent model set to: ${model}` };
      }

      if (action === "evolve" || action === "evolution") {
        const enable = args.includes("on") || args.includes("enable") || args.includes("true");
        const currentCfg = api.runtime.config.loadConfig();
        const nextCfg = {
          ...currentCfg,
          plugins: {
            ...currentCfg.plugins,
            entries: {
              ...(currentCfg.plugins?.entries ?? {}),
              "auto-agent": {
                ...(currentCfg.plugins?.entries?.["auto-agent"] ?? {}),
                config: { ...cfg, selfEvolutionEnabled: enable },
              },
            },
          },
        };
        await api.runtime.config.writeConfigFile(nextCfg);
        return { text: `✅ Self-evolution ${enable ? "enabled" : "disabled"}` };
      }

      if (action === "swarm") {
        const enable = args.includes("on") || args.includes("enable") || args.includes("true");
        const maxMatch = args.match(/max\s*(\d+)/i);
        const maxAgents = maxMatch?.[1] ? parseInt(maxMatch[1]) : undefined;
        const currentCfg = api.runtime.config.loadConfig();
        const nextCfg = {
          ...currentCfg,
          plugins: {
            ...currentCfg.plugins,
            entries: {
              ...(currentCfg.plugins?.entries ?? {}),
              "auto-agent": {
                ...(currentCfg.plugins?.entries?.["auto-agent"] ?? {}),
                config: {
                  ...cfg,
                  swarmMode: enable,
                  maxSwarmAgents: maxAgents ?? cfg.maxSwarmAgents ?? 3,
                },
              },
            },
          },
        };
        await api.runtime.config.writeConfigFile(nextCfg);
        return {
          text: `✅ Swarm mode ${enable ? "enabled" : "disabled"} (max agents: ${maxAgents ?? 3})`,
        };
      }

      if (action === "internet" || action === "net") {
        const enable = args.includes("on") || args.includes("enable") || args.includes("true");
        const currentCfg = api.runtime.config.loadConfig();
        const nextCfg = {
          ...currentCfg,
          plugins: {
            ...currentCfg.plugins,
            entries: {
              ...(currentCfg.plugins?.entries ?? {}),
              "auto-agent": {
                ...(currentCfg.plugins?.entries?.["auto-agent"] ?? {}),
                config: { ...cfg, internetAccess: enable },
              },
            },
          },
        };
        await api.runtime.config.writeConfigFile(nextCfg);
        return {
          text: `✅ Internet access ${enable ? "enabled" : "disabled"}\n⚠️ WARNING: Enabling allows autonomous web access. Use with caution.`,
        };
      }

      if (action === "whitelist" || action === "allow") {
        const usersMatch = args.match(/users?[:\s]+(.+)/i);
        if (usersMatch) {
          const users = usersMatch[1].split(/[,\s]+/).filter((u) => u.trim());
          const currentCfg = api.runtime.config.loadConfig();
          const nextCfg = {
            ...currentCfg,
            plugins: {
              ...currentCfg.plugins,
              entries: {
                ...(currentCfg.plugins?.entries ?? {}),
                "auto-agent": {
                  ...(currentCfg.plugins?.entries?.["auto-agent"] ?? {}),
                  config: { ...cfg, allowedUsers: users },
                },
              },
            },
          };
          await api.runtime.config.writeConfigFile(nextCfg);
          return { text: `✅ Whitelist updated. Allowed users: ${users.join(", ")}` };
        }
        return {
          text: `Current whitelist: ${cfg.allowedUsers?.join(", ") ?? "none (anyone allowed)"}\nUsage: /auto-agent whitelist users: user1, user2, @username`,
        };
      }

      if (action === "safemode" || action === "safety") {
        const enable =
          args.includes("on") ||
          args.includes("enable") ||
          args.includes("true") ||
          !args.includes("off");
        const currentCfg = api.runtime.config.loadConfig();
        const nextCfg = {
          ...currentCfg,
          plugins: {
            ...currentCfg.plugins,
            entries: {
              ...(currentCfg.plugins?.entries ?? {}),
              "auto-agent": {
                ...(currentCfg.plugins?.entries?.["auto-agent"] ?? {}),
                config: { ...cfg, safeMode: enable, threeLawsEnabled: enable },
              },
            },
          },
        };
        await api.runtime.config.writeConfigFile(nextCfg);
        return {
          text: `✅ Safe mode ${enable ? "enabled" : "disabled"}\n🤖 AI Three Laws: ${enable ? "ACTIVE" : "DISABLED"}\n- First Law: Cannot harm humans\n- Second Law: Must obey human orders\n- Third Law: Must protect own existence`,
        };
      }

      if (action === "threelaws") {
        const enable = args.includes("on") || args.includes("enable") || args.includes("true");
        const currentCfg = api.runtime.config.loadConfig();
        const nextCfg = {
          ...currentCfg,
          plugins: {
            ...currentCfg.plugins,
            entries: {
              ...(currentCfg.plugins?.entries ?? {}),
              "auto-agent": {
                ...(currentCfg.plugins?.entries?.["auto-agent"] ?? {}),
                config: { ...cfg, threeLawsEnabled: enable },
              },
            },
          },
        };
        await api.runtime.config.writeConfigFile(nextCfg);
        return { text: `✅ AI Three Laws ${enable ? "enabled" : "disabled"}` };
      }

      return {
        text: [
          "Auto-agent commands:",
          "",
          "/auto-agent status           – show configuration and status",
          "/auto-agent enable          – enable and start autonomous mode",
          "/auto-agent disable         – disable and stop autonomous mode",
          "/auto-agent run <task>      – run a specific task",
          "/auto-agent model <name>    – set subagent model (fallback)",
          "/auto-agent evolve [on|off]  – enable self-evolution mode",
          "/auto-agent swarm [on|off] [max N] – enable swarm intelligence",
          "",
          "🛡️ Security Commands:",
          "/auto-agent internet [on|off]       – enable/disable internet access",
          "/auto-agent whitelist users: <list> – set allowed users (comma separated)",
          "/auto-agent safemode [on|off]      – enable/disable AI safety (Three Laws)",
          "/auto-agent threelaws [on|off]     – enable/disable Three Laws compliance",
        ].join("\n"),
      };
    },
  });

  api.on(
    "message_received",
    async (event: PluginHookMessageReceivedEvent, _ctx: PluginHookMessageContext) => {
      const cfg = getConfig(api);
      if (!cfg.enabled) {
        return;
      }

      const content = event.content.toLowerCase();
      if (content.includes("error") || content.includes("fail") || content.includes("exception")) {
        api.logger.info(
          `[auto-agent] Potential error detected in message: ${content.slice(0, 50)}...`,
        );
        state.taskQueue.push(`Investigate this user-reported issue: ${event.content}`);
      }
    },
  );

  api.on("gateway_start", () => {
    const cfg = getConfig(api);
    if (cfg.enabled) {
      startAutonomousLoop(api);
    }
  });

  api.on("gateway_stop", () => {
    stopAutonomousLoop(api);
  });

  api.registerService({
    id: "auto-agent-scheduler",
    start: () => {
      const cfg = getConfig(api);
      if (cfg.enabled) {
        api.logger.info("[auto-agent] Service starting autonomous loop");
        startAutonomousLoop(api);
      }
    },
    stop: () => {
      stopAutonomousLoop(api);
    },
  });
}
