import os from "node:os";
import type { OpenClawConfig } from "../config/config.js";
import { readConfigFileSnapshot } from "../config/io.js";
import { captureSystemSnapshot } from "./self-metrics.js";

export interface RepairResult {
  success: boolean;
  repairs: RepairAction[];
  errors: string[];
  config: OpenClawConfig;
}

export interface RepairAction {
  type: string;
  description: string;
  before: unknown;
  after: unknown;
  timestamp: Date;
}

export interface HealthCheck {
  name: string;
  status: "healthy" | "warning" | "critical";
  message: string;
  suggestion?: string;
}

export class SelfRepairEngine {
  private repairHistory: RepairAction[] = [];
  private config: OpenClawConfig | null = null;

  async loadConfig(): Promise<OpenClawConfig> {
    const snapshot = await readConfigFileSnapshot();
    this.config = snapshot.config;
    return this.config;
  }

  async runHealthChecks(): Promise<HealthCheck[]> {
    const checks: HealthCheck[] = [];

    if (!this.config) {
      await this.loadConfig();
    }

    checks.push(this.checkModelConfiguration());
    checks.push(this.checkProviderAvailability());
    checks.push(this.checkMemorySettings());
    checks.push(await this.checkDiskSpace());
    checks.push(this.checkNodeProcessMemory());

    return checks;
  }

  private checkModelConfiguration(): HealthCheck {
    const model = this.config?.agents?.defaults?.model;

    if (!model?.primary) {
      return {
        name: "model_configuration",
        status: "critical",
        message: "No primary model configured",
        suggestion: "Set agents.defaults.model.primary to a valid provider/model",
      };
    }

    if (!model.fallbacks || model.fallbacks.length === 0) {
      return {
        name: "model_configuration",
        status: "warning",
        message: "No fallback models configured",
        suggestion: "Add fallback models for resilience",
      };
    }

    return {
      name: "model_configuration",
      status: "healthy",
      message: `Model configured: ${model.primary}`,
    };
  }

  private checkProviderAvailability(): HealthCheck {
    const providers = this.config?.agents?.defaults?.model?.fallbacks || [];

    if (providers.length === 0) {
      return {
        name: "provider_availability",
        status: "warning",
        message: "No provider fallback configured",
        suggestion: "Configure fallback providers for reliability",
      };
    }

    return {
      name: "provider_availability",
      status: "healthy",
      message: `${providers.length} fallback(s) configured`,
    };
  }

  private checkMemorySettings(): HealthCheck {
    const memorySearch = this.config?.agents?.defaults?.memorySearch;

    if (!memorySearch) {
      return {
        name: "memory_settings",
        status: "warning",
        message: "Memory search not configured",
        suggestion: "Enable memory search for better context retention",
      };
    }

    if (memorySearch.enabled === false) {
      return {
        name: "memory_settings",
        status: "warning",
        message: "Memory search is disabled",
        suggestion: "Enable memory.search.enabled for memory capabilities",
      };
    }

    return {
      name: "memory_settings",
      status: "healthy",
      message: "Memory search enabled",
    };
  }

  private async checkDiskSpace(): Promise<HealthCheck> {
    const snap = await captureSystemSnapshot().catch(() => null);
    if (!snap) {
      return { name: "disk_space", status: "warning", message: "Could not check disk space" };
    }
    if (snap.freeDiskRatio < 0.05) {
      return {
        name: "disk_space",
        status: "critical",
        message: `Disk critically low: ${(snap.freeDiskRatio * 100).toFixed(1)}% free`,
        suggestion: "Free disk space to avoid memory/config write failures",
      };
    }
    if (snap.freeDiskRatio < 0.15) {
      return {
        name: "disk_space",
        status: "warning",
        message: `Disk space low: ${(snap.freeDiskRatio * 100).toFixed(1)}% free`,
        suggestion: "Consider freeing disk space soon",
      };
    }
    return {
      name: "disk_space",
      status: "healthy",
      message: `Disk OK: ${(snap.freeDiskRatio * 100).toFixed(1)}% free`,
    };
  }

  private checkNodeProcessMemory(): HealthCheck {
    const mem = process.memoryUsage();
    const heapPressure = mem.heapUsed / (mem.heapTotal || 1);
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const systemPressure = 1 - freeMem / totalMem;

    if (heapPressure > 0.9 || systemPressure > 0.95) {
      return {
        name: "process_memory",
        status: "critical",
        message: `Heap pressure: ${(heapPressure * 100).toFixed(0)}%, system: ${(systemPressure * 100).toFixed(0)}%`,
        suggestion: "Restart agent to reclaim memory",
      };
    }
    if (heapPressure > 0.75 || systemPressure > 0.85) {
      return {
        name: "process_memory",
        status: "warning",
        message: `Heap pressure: ${(heapPressure * 100).toFixed(0)}%, system: ${(systemPressure * 100).toFixed(0)}%`,
        suggestion: "Monitor memory usage",
      };
    }
    return {
      name: "process_memory",
      status: "healthy",
      message: `Heap: ${(heapPressure * 100).toFixed(0)}%, system: ${(systemPressure * 100).toFixed(0)}% used`,
    };
  }

  async repair(): Promise<RepairResult> {
    const errors: string[] = [];

    if (!this.config) {
      await this.loadConfig();
    }

    try {
      this.repairMissingFallbacks();
      this.repairMemorySettings();
      this.repairContextPruning();
    } catch (error) {
      errors.push(String(error));
    }

    return {
      success: errors.length === 0,
      repairs: this.repairHistory,
      errors,
      config: this.config!,
    };
  }

  private repairMissingFallbacks(): void {
    if (!this.config?.agents?.defaults?.model?.fallbacks) {
      const before = this.config?.agents?.defaults?.model?.fallbacks;
      const fallbacks = ["ollama/rnj-1-instruct", "ollama/aegis-phi3.5-jpv2.5"];

      if (!this.config!.agents!.defaults!.model) {
        this.config!.agents!.defaults!.model = {};
      }
      this.config!.agents!.defaults!.model.fallbacks = fallbacks;

      this.repairHistory.push({
        type: "add_fallbacks",
        description: "Added fallback model for reliability",
        before: before ?? undefined,
        after: fallbacks,
        timestamp: new Date(),
      });
    }
  }

  private repairMemorySettings(): void {
    if (!this.config?.agents?.defaults?.memorySearch?.enabled) {
      const before = this.config?.agents?.defaults?.memorySearch?.enabled;

      if (!this.config!.agents!.defaults!.memorySearch) {
        this.config!.agents!.defaults!.memorySearch = {};
      }
      this.config!.agents!.defaults!.memorySearch.enabled = true;

      this.repairHistory.push({
        type: "enable_memory",
        description: "Enabled memory search",
        before: before ?? undefined,
        after: true,
        timestamp: new Date(),
      });
    }
  }

  private repairContextPruning(): void {
    if (!this.config?.agents?.defaults?.contextPruning?.mode) {
      const before = this.config?.agents?.defaults?.contextPruning?.mode;

      if (!this.config!.agents!.defaults!.contextPruning) {
        this.config!.agents!.defaults!.contextPruning = {};
      }
      this.config!.agents!.defaults!.contextPruning.mode = "cache-ttl";

      this.repairHistory.push({
        type: "enable_pruning",
        description: "Enabled context pruning",
        before: before ?? undefined,
        after: "cache-ttl",
        timestamp: new Date(),
      });
    }
  }

  getRepairHistory(): RepairAction[] {
    return this.repairHistory;
  }

  async saveRepairedConfig(): Promise<void> {
    if (!this.config) {
      throw new Error("No config to save");
    }

    const { writeConfigFile } = await import("../config/io.js");
    await writeConfigFile(this.config);
  }
}

export async function runSelfRepair(): Promise<RepairResult> {
  const engine = new SelfRepairEngine();
  await engine.loadConfig();
  const result = await engine.repair();

  if (result.success) {
    await engine.saveRepairedConfig();
  }

  return result;
}

export async function runHealthCheck(): Promise<HealthCheck[]> {
  const engine = new SelfRepairEngine();
  await engine.loadConfig();
  return engine.runHealthChecks();
}
