import { AppRegistry, createRuntime } from "@aotui/runtime";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveAotuiAgentAppNames, resolveAotuiRegistryEntries } from "./policy.js";
import { InMemorySessionDesktopManager } from "./session-desktop-manager.js";
import type { AotuiKernelService, SessionDesktopManager } from "./types.js";

const log = createSubsystemLogger("aotui");

export class DefaultAotuiKernelService implements AotuiKernelService {
  private started = false;
  private kernel?: ReturnType<typeof createRuntime>;
  private desktopManager?: SessionDesktopManager;
  private appRegistry?: AppRegistry;

  constructor(private readonly config?: OpenClawConfig) {}

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.kernel = createRuntime({});
    this.appRegistry = new AppRegistry();
    const registryEntries = resolveAotuiRegistryEntries(this.config);
    if (registryEntries.length > 0) {
      await this.appRegistry.loadFromEntries(registryEntries, { replace: true });
    }
    this.desktopManager = new InMemorySessionDesktopManager(this.kernel, {
      afterCreate: async (record) => {
        await this.installConfiguredApps(record);
      },
    });
    this.started = true;
  }

  async stop(reason?: string): Promise<void> {
    if (!this.started) {
      return;
    }

    if (this.desktopManager) {
      await this.desktopManager.destroyAll(reason ?? "service_stop");
    }

    this.desktopManager = undefined;
    this.appRegistry = undefined;
    this.kernel = undefined;
    this.started = false;
  }

  isStarted(): boolean {
    return this.started;
  }

  getKernel() {
    if (!this.kernel) {
      throw new Error("AOTUI kernel service has not been started");
    }
    return this.kernel;
  }

  getDesktopManager(): SessionDesktopManager {
    if (!this.desktopManager) {
      throw new Error("AOTUI kernel service has not been started");
    }
    return this.desktopManager;
  }

  private async installConfiguredApps(record: {
    desktopId: string;
    sessionKey: string;
    agentId: string;
    workspaceDir?: string;
  }): Promise<void> {
    const kernel = this.kernel;
    const appRegistry = this.appRegistry;
    if (!kernel || !appRegistry) {
      return;
    }

    const desktop = kernel.getDesktop(record.desktopId as never);
    const dynamicConfig = record.workspaceDir
      ? {
          projectPath: record.workspaceDir,
          workspaceDir: record.workspaceDir,
        }
      : undefined;
    const selectedNames = resolveAotuiAgentAppNames(this.config, record.agentId);
    if (selectedNames.length === 0) {
      log.info("no AOTUI apps configured for agent", {
        sessionKey: record.sessionKey,
        desktopId: record.desktopId,
        agentId: record.agentId,
      });
      return;
    }

    const installableNames = selectedNames.filter((name) => appRegistry.has(name));
    const missingNames = selectedNames.filter((name) => !appRegistry.has(name));
    if (missingNames.length > 0) {
      log.warn("skipping unknown AOTUI app entries", {
        sessionKey: record.sessionKey,
        desktopId: record.desktopId,
        agentId: record.agentId,
        missingAppNames: missingNames,
      });
    }
    if (installableNames.length === 0) {
      return;
    }
    const installedIds = await appRegistry.installSelected(desktop, installableNames, {
      dynamicConfig,
    });

    log.info("installed configured AOTUI apps", {
      sessionKey: record.sessionKey,
      desktopId: record.desktopId,
      agentId: record.agentId,
      workspaceDir: record.workspaceDir,
      installedAppCount: installedIds.length,
      installedAppIds: installedIds,
    });
  }
}

export function createOpenClawKernelService(config?: OpenClawConfig): AotuiKernelService {
  return new DefaultAotuiKernelService(config);
}
