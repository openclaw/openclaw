import type { OpenClawConfig } from "../config/config.js";
import { OpenClawAgentAdapter } from "./agent-adapter.js";
import { createOpenClawKernelService } from "./kernel-service.js";
import type { AotuiKernelService, OpenClawAgentHandle } from "./types.js";

let gatewayKernelService: AotuiKernelService | null = null;

export type { OpenClawAgentHandle } from "./types.js";

export function getAotuiGatewayRuntime(): AotuiKernelService | null {
  return gatewayKernelService;
}

export async function startAotuiGatewayRuntime(
  config?: OpenClawConfig,
): Promise<AotuiKernelService> {
  if (gatewayKernelService) {
    return gatewayKernelService;
  }

  const service = createOpenClawKernelService(config);
  await service.start();
  gatewayKernelService = service;
  return service;
}

export async function stopAotuiGatewayRuntime(reason?: string): Promise<void> {
  if (!gatewayKernelService) {
    return;
  }

  const active = gatewayKernelService;
  gatewayKernelService = null;
  await active.stop(reason);
}

export async function syncAotuiDesktopForRun(params: {
  sessionKey?: string;
  sessionId: string;
  agentId: string;
  workspaceDir: string;
  isNewSession: boolean;
}): Promise<void> {
  const service = getAotuiGatewayRuntime();
  if (!service || !service.isEnabled() || !params.sessionKey) {
    return;
  }

  const desktopManager = service.getDesktopManager();
  if (params.isNewSession) {
    await desktopManager.resetDesktop(params.sessionKey, {
      sessionId: params.sessionId,
      agentId: params.agentId,
      workspaceDir: params.workspaceDir,
      reason: "session_reset",
    });
    return;
  }

  await desktopManager.ensureDesktop({
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId: params.agentId,
    workspaceDir: params.workspaceDir,
  });
}

export async function installAotuiAdapterForRun(params: {
  sessionKey?: string;
  sessionId: string;
  agentId: string;
  runId: string;
  agent: OpenClawAgentHandle;
}): Promise<OpenClawAgentAdapter | null> {
  const service = getAotuiGatewayRuntime();
  if (!service || !service.isEnabled() || !params.sessionKey) {
    return null;
  }

  const baseTools = [...(params.agent.state.tools ?? [])];
  const adapter = new OpenClawAgentAdapter({
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId: params.agentId,
    kernel: service.getKernel(),
    desktopManager: service.getDesktopManager(),
    agent: params.agent,
    baseTools,
    ownerId: params.runId,
  });
  await adapter.install();
  return adapter;
}

export async function reinitializeAotuiDesktopForCompaction(params: {
  sessionKey?: string;
  reason?: string;
}): Promise<boolean> {
  const service = getAotuiGatewayRuntime();
  if (!service || !service.isEnabled() || !params.sessionKey) {
    return false;
  }

  const record = service.getDesktopManager().getDesktop(params.sessionKey);
  if (!record) {
    return false;
  }

  await service.getKernel().reinitializeDesktopApps(record.desktopId, {
    reason: params.reason ?? "context_compaction",
  });
  return true;
}
