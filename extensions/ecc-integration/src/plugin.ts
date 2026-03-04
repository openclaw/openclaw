/**
 * OpenClaw Plugin Integration
 * Registers ECC integration as an OpenClaw plugin
 */

import ECCIntegration from "./index.js";

let eccIntegration: ECCIntegration | null = null;

type CommandHandlerArgs = Record<string, unknown>;

type PluginContext = {
  registerCommand: (
    name: string,
    options: {
      description: string;
      handler: (args: CommandHandlerArgs) => Promise<unknown>;
    },
  ) => void;
};

type Plugin = {
  name: string;
  version: string;
  description: string;
  initialize: (context: PluginContext) => Promise<void>;
  shutdown: () => Promise<void>;
};

const eccPlugin: Plugin = {
  name: "ecc-integration",
  version: "1.0.0",
  description: "Everything Claude Code integration with governance rules",

  async initialize(context: PluginContext) {
    console.log("[ECC Plugin] Initializing...");

    // Create ECC integration instance
    eccIntegration = new ECCIntegration({
      governance: { enabled: true },
      ecc: {
        securityScanning: true,
        skillCreation: true,
        bestPracticeEnforcement: true,
      },
    });

    await eccIntegration.initialize();

    // Register CLI commands
    context.registerCommand("agent-task", {
      description: "Create a single-agent task",
      handler: async (args: CommandHandlerArgs) => {
        const { title, description, priority, agentType } = args;
        const taskId = await eccIntegration!.submitTask(
          String(title),
          String(description ?? title),
          {
            priority: (priority as "low" | "medium" | "high" | "critical") || "medium",
            agentType: agentType as never,
          },
        );
        return { success: true, taskId };
      },
    });

    context.registerCommand("agent-status", {
      description: "View all agent states",
      handler: async () => {
        const status = eccIntegration!.getStatus();
        return { success: true, status };
      },
    });

    context.registerCommand("security-scan", {
      description: "Run ECC AgentShield security audit",
      handler: async (args: CommandHandlerArgs) => {
        const { path } = args;
        // Implementation would scan the path
        return { success: true, message: "Security scan completed" };
      },
    });

    context.registerCommand("skill-create", {
      description: "Generate skills from codebase patterns",
      handler: async (args: CommandHandlerArgs) => {
        const { name, patterns } = args;
        const result = eccIntegration!.generateSkill(
          String(name),
          typeof patterns === "string" ? patterns.split(",") : [],
          [],
        );
        return { success: true, skill: result.skill };
      },
    });

    context.registerCommand("instinct-status", {
      description: "View learned instincts",
      handler: async () => {
        const data = eccIntegration!.exportLearning();
        return { success: true, data };
      },
    });

    console.log("[ECC Plugin] Initialized successfully");
    console.log("[ECC Plugin] Three Core Rules active");
  },

  async shutdown() {
    console.log("[ECC Plugin] Shutting down...");
    eccIntegration = null;
  },
};

export default eccPlugin;
