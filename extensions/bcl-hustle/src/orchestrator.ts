/**
 * BCL Master Orchestrator
 *
 * Central control system that coordinates all subagents
 */

import { Cron } from "croner";
import type { OpenClawPluginApi } from "../../src/plugins/types.js";
import {
  getHealthStatus,
  updateAgentHealth,
  getProjects,
  getOpportunities,
  getMilestones,
  getDecisions,
} from "./db/database.js";
import type { BCLAgentType, ScheduleConfig } from "./types/index.js";
import { DEFAULT_SCHEDULES, BCL_CORE_VALUES } from "./types/index.js";

interface AgentInstance {
  agent: any;
  lastRun: Date | null;
  running: boolean;
}

export class MasterOrchestrator {
  private api: OpenClawPluginApi;
  private agents: Map<BCLAgentType, AgentInstance> = new Map();
  private schedules: Map<BCLAgentType, Cron> = new Map();
  private running: boolean = false;

  constructor(api: OpenClawPluginApi) {
    this.api = api;
    this.initializeAgents();
  }

  private initializeAgents() {
    // Import agents dynamically
    import("./agents/research-agent.js").then(({ ResearchAgent }) => {
      this.agents.set("research", {
        agent: new ResearchAgent(this.api),
        lastRun: null,
        running: false,
      });
    });
    import("./agents/competitor-agent.js").then(({ CompetitorAgent }) => {
      this.agents.set("competitor", {
        agent: new CompetitorAgent(this.api),
        lastRun: null,
        running: false,
      });
    });
    import("./agents/builder-agent.js").then(({ BuilderAgent }) => {
      this.agents.set("builder", {
        agent: new BuilderAgent(this.api),
        lastRun: null,
        running: false,
      });
    });
    import("./agents/security-agent.js").then(({ SecurityAgent }) => {
      this.agents.set("security", {
        agent: new SecurityAgent(this.api),
        lastRun: null,
        running: false,
      });
    });
    import("./agents/marketer-agent.js").then(({ MarketerAgent }) => {
      this.agents.set("marketer", {
        agent: new MarketerAgent(this.api),
        lastRun: null,
        running: false,
      });
    });
    import("./agents/finance-agent.js").then(({ FinanceAgent }) => {
      this.agents.set("finance", {
        agent: new FinanceAgent(this.api),
        lastRun: null,
        running: false,
      });
    });
    import("./agents/comms-agent.js").then(({ CommsAgent }) => {
      this.agents.set("comms", { agent: new CommsAgent(this.api), lastRun: null, running: false });
    });
    import("./agents/market-predictor-agent.js").then(({ MarketPredictorAgent }) => {
      this.agents.set("market_predictor", {
        agent: new MarketPredictorAgent(this.api),
        lastRun: null,
        running: false,
      });
    });

    this.api.logger.info("Initialized BCL agents");
  }

  async start(): Promise<void> {
    if (this.running) {
      this.api.logger.warn("BCL Orchestrator already running");
      return;
    }

    this.running = true;
    this.api.logger.info("Starting BCL Master Orchestrator...");

    // Schedule all agents
    for (const schedule of DEFAULT_SCHEDULES) {
      if (schedule.enabled) {
        this.scheduleAgent(schedule.agent, schedule.cron);
      }
    }

    // Run initial execution
    await this.runAgent("research");
    await this.runAgent("competitor");
    await this.runAgent("market_predictor");

    this.api.logger.info("BCL Master Orchestrator started");
  }

  stop(): void {
    this.running = false;

    for (const [agentType, cron] of this.schedules) {
      cron.stop();
      this.api.logger.info(`Stopped schedule for ${agentType}`);
    }
    this.schedules.clear();

    this.api.logger.info("BCL Master Orchestrator stopped");
  }

  private scheduleAgent(agentType: BCLAgentType, cronExpression: string): void {
    try {
      const cron = new Cron(cronExpression, async () => {
        this.api.logger.info(`Scheduled execution: ${agentType}`);
        await this.runAgent(agentType);
      });

      this.schedules.set(agentType, cron);
      this.api.logger.info(`Scheduled ${agentType} with cron: ${cronExpression}`);
    } catch (error) {
      this.api.logger.error(`Failed to schedule ${agentType}` + String(error));
    }
  }

  async runAgent(agentType: BCLAgentType): Promise<void> {
    const instance = this.agents.get(agentType);
    if (!instance) {
      this.api.logger.error(`Unknown agent: ${agentType}`);
      return;
    }

    if (instance.running) {
      this.api.logger.warn(`Agent ${agentType} already running, skipping`);
      return;
    }

    instance.running = true;
    updateAgentHealth(agentType, "healthy");

    try {
      this.api.logger.info(`Running agent: ${agentType}`);
      await instance.agent.execute();
      instance.lastRun = new Date();
      updateAgentHealth(agentType, "healthy");
      this.api.logger.info(`Agent ${agentType} completed successfully`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.api.logger.error(`Agent ${agentType} failed` + String(error));
      updateAgentHealth(agentType, "degraded", errorMessage);
    } finally {
      instance.running = false;
    }
  }

  async executeAgent(agentType: BCLAgentType, action: string, params?: any): Promise<any> {
    const instance = this.agents.get(agentType);
    if (!instance) {
      return { success: false, error: `Unknown agent: ${agentType}` };
    }

    try {
      if (typeof instance.agent[action] === "function") {
        return await instance.agent[action](params);
      }
      return { success: false, error: `Action ${action} not found on agent ${agentType}` };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, error: errorMessage };
    }
  }

  getStatus(): any {
    return {
      running: this.running,
      agents: Object.fromEntries(
        Array.from(this.agents.entries()).map(([key, val]) => [
          key,
          {
            lastRun: val.lastRun,
            running: val.running,
          },
        ]),
      ),
      schedules: Array.from(this.schedules.keys()),
      health: getHealthStatus(),
    };
  }
}
