import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { AgentInfo } from "./telegram-ui/agent-panel.js";
import type { CronJobInfo } from "./telegram-ui/cron-panel.js";
import type { ModelInfo } from "./telegram-ui/model-panel.js";
import type { CIStatus } from "./devops/ci-monitor.js";
import type { SystemSnapshot } from "./telegram-ui/main-menu.js";

export class GatewayRPC {
  constructor(private api: OpenClawPluginApi) {}

  async fetchAgents(): Promise<AgentInfo[]> {
    try {
      const agents: any[] = await this.api.runtime.gateway.call("agents.list");
      return agents.map((a) => ({
        id: a.id ?? a.agentId ?? "unknown",
        name: a.name ?? a.id ?? "Agent",
        status: a.status === "running" ? "running" : a.status === "error" ? "error" : "idle",
        model: a.model ?? a.modelId,
        sessionTurns: a.sessionTurns,
      }));
    } catch {
      return [
        { id: "main", name: "Claude (Brain)", status: "idle" },
        { id: "coder", name: "Codex (Hands)", status: "idle" },
      ];
    }
  }

  async fetchActiveAgentId(): Promise<string> {
    try {
      const identity: any = await this.api.runtime.gateway.call("agent.identity.get");
      return identity?.agentId ?? "main";
    } catch {
      return "main";
    }
  }

  async fetchCronJobs(): Promise<CronJobInfo[]> {
    try {
      const jobs: any[] = await this.api.runtime.gateway.call("cron.list");
      return jobs.map((j) => ({
        id: j.id,
        enabled: j.enabled ?? true,
        schedule: j.schedule?.expr ?? j.schedule ?? "",
        timezone: j.schedule?.tz,
        nextRun: j.nextRun,
        description: j.payload?.message,
        lastResult: j.lastRun?.status === "ok" ? "success" : j.lastRun?.status === "error" ? "failure" : undefined,
      }));
    } catch {
      return [];
    }
  }

  async toggleCronJob(id: string, enabled: boolean): Promise<void> {
    await this.api.runtime.gateway.call("cron.update", { id, enabled });
  }

  async runCronJob(id: string): Promise<void> {
    await this.api.runtime.gateway.call("cron.run", { id });
  }

  async fetchModels(): Promise<ModelInfo[]> {
    try {
      const models: any[] = await this.api.runtime.gateway.call("models.list");
      return models.map((m) => ({
        id: m.id ?? m.modelId ?? "unknown",
        name: m.name ?? m.displayName ?? m.id ?? "Model",
        provider: m.provider ?? "unknown",
        isCurrent: m.isCurrent ?? false,
      }));
    } catch {
      return [];
    }
  }

  async fetchCurrentModel(): Promise<string | undefined> {
    try {
      const models = await this.fetchModels();
      return models.find((m) => m.isCurrent)?.id;
    } catch {
      return undefined;
    }
  }

  async switchModel(modelId: string): Promise<void> {
    await this.api.runtime.gateway.call("sessions.patch", { model: modelId });
  }

  async switchAgent(agentId: string): Promise<void> {
    await this.api.runtime.gateway.call("config.patch", {
      path: "agents.default",
      value: agentId,
    });
  }

  async resetSession(): Promise<void> {
    await this.api.runtime.gateway.call("sessions.reset", {});
  }

  async fetchSystemSnapshot(): Promise<SystemSnapshot> {
    try {
      const [agents, cronJobs] = await Promise.all([
        this.fetchAgents(),
        this.fetchCronJobs(),
      ]);

      const activeAgent = agents.find((a) => a.status === "running");
      const enabledCrons = cronJobs.filter((j) => j.enabled).length;

      return {
        agentStatus: activeAgent ? `${activeAgent.name} 運行中` : "待命中",
        activeWorkflows: 0,
        pendingApprovals: 0,
        cronJobsEnabled: enabledCrons,
      };
    } catch {
      return {
        agentStatus: "狀態未知",
        activeWorkflows: 0,
        pendingApprovals: 0,
        cronJobsEnabled: 0,
      };
    }
  }

  async fetchApprovals(): Promise<Array<{ id: string; description: string }>> {
    try {
      const list: any[] = await this.api.runtime.gateway.call("exec.approval.list");
      return list.map((a) => ({
        id: a.id ?? a.approvalId,
        description: a.description ?? a.command ?? "pending operation",
      }));
    } catch {
      return [];
    }
  }

  async approveExecution(id: string): Promise<void> {
    await this.api.runtime.gateway.call("exec.approval.resolve", { id, decision: "approve" });
  }

  async denyExecution(id: string): Promise<void> {
    await this.api.runtime.gateway.call("exec.approval.resolve", { id, decision: "deny" });
  }

  async fetchHealth(): Promise<{ ok: boolean; details?: string }> {
    try {
      const health: any = await this.api.runtime.gateway.call("health");
      return { ok: health?.ok ?? true, details: health?.message };
    } catch (err: any) {
      return { ok: false, details: err?.message };
    }
  }

  async fetchUsage(): Promise<{ tokensToday: number; costToday: number }> {
    try {
      const usage: any = await this.api.runtime.gateway.call("usage.status");
      return {
        tokensToday: usage?.tokensToday ?? 0,
        costToday: usage?.costToday ?? 0,
      };
    } catch {
      return { tokensToday: 0, costToday: 0 };
    }
  }

  async fetchChatHistory(limit = 10): Promise<Array<{ role: string; content: string }>> {
    try {
      const history: any = await this.api.runtime.gateway.call("chat.history", { limit });
      return Array.isArray(history) ? history : [];
    } catch {
      return [];
    }
  }

  async sendChatAbort(): Promise<void> {
    await this.api.runtime.gateway.call("chat.abort", {});
  }

  async fetchToolsCatalog(): Promise<string[]> {
    try {
      const tools: any[] = await this.api.runtime.gateway.call("tools.catalog");
      return tools.map((t) => t.name ?? t.id ?? String(t));
    } catch {
      return [];
    }
  }

  async fetchChannelStatus(): Promise<Record<string, string>> {
    try {
      const status: any = await this.api.runtime.gateway.call("channels.status");
      return status ?? {};
    } catch {
      return {};
    }
  }
}

let _instance: GatewayRPC | null = null;

export function getGatewayRPC(api: OpenClawPluginApi): GatewayRPC {
  if (!_instance) {
    _instance = new GatewayRPC(api);
  }
  return _instance;
}
