/**
 * Skills API.
 *
 * Provides access to the gateway's skill management functionality.
 */

import { getGatewayClient } from "./gateway-client";

export interface SkillStatusEntry {
  name: string;
  description: string;
  source: string;
  bundled: boolean;
  filePath: string;
  baseDir: string;
  skillKey: string;
  primaryEnv?: string;
  emoji?: string;
  homepage?: string;
  always: boolean;
  disabled: boolean;
  blockedByAllowlist: boolean;
  eligible: boolean;
  requirements: {
    bins: string[];
    anyBins: string[];
    env: string[];
    config: string[];
    os: string[];
  };
  missing: {
    bins: string[];
    anyBins: string[];
    env: string[];
    config: string[];
    os: string[];
  };
  configChecks: Array<{ path: string; value: unknown; satisfied: boolean }>;
  install: Array<{
    id: string;
    kind: string;
    label: string;
    bins: string[];
    installed?: boolean;
    uninstall?: {
      kind: string;
      label: string;
      bins: string[];
    };
  }>;
}

export interface SkillsStatusReport {
  workspaceDir: string;
  managedSkillsDir: string;
  skills: SkillStatusEntry[];
}

export interface SkillUpdateParams {
  skillKey: string;
  enabled?: boolean;
  apiKey?: string;
  env?: Record<string, string>;
}

export interface SkillInstallParams {
  name: string;
  installId: string;
  timeoutMs?: number;
}

export interface SkillInstallResult {
  ok: boolean;
  installId?: string;
  message?: string;
}

export interface SkillUninstallParams {
  name: string;
  installId: string;
  timeoutMs?: number;
}

export interface SkillUninstallResult {
  ok: boolean;
  message?: string;
}

/**
 * Get the status of all skills
 */
export async function getSkillsStatus(params?: { agentId?: string }): Promise<SkillsStatusReport> {
  const client = getGatewayClient();
  return client.request<SkillsStatusReport>("skills.status", params ?? {});
}

/**
 * Get a specific skill by name from the status report
 */
export async function getSkill(name: string, agentId?: string): Promise<SkillStatusEntry> {
  const report = await getSkillsStatus(agentId ? { agentId } : undefined);
  const entry = report.skills.find((skill) => skill.name === name || skill.skillKey === name);
  if (!entry) {
    throw new Error(`Skill "${name}" not found`);
  }
  return entry;
}

/**
 * Update a skill's configuration or enabled state
 */
export async function updateSkill(
  params: SkillUpdateParams
): Promise<{ ok: boolean; skillKey: string; config: Record<string, unknown> }> {
  const client = getGatewayClient();
  return client.request("skills.update", params);
}

/**
 * Enable a skill
 */
export async function enableSkill(skillKey: string): Promise<{ ok: boolean }> {
  const client = getGatewayClient();
  return client.request("skills.update", { skillKey, enabled: true });
}

/**
 * Disable a skill
 */
export async function disableSkill(skillKey: string): Promise<{ ok: boolean }> {
  const client = getGatewayClient();
  return client.request("skills.update", { skillKey, enabled: false });
}

/**
 * Install a new skill
 * Note: This operation can take up to 120 seconds for remote skills
 */
export async function installSkill(params: SkillInstallParams): Promise<SkillInstallResult> {
  const client = getGatewayClient();
  return client.request<SkillInstallResult>("skills.install", params, {
    timeout: params.timeoutMs ?? 120000,
  });
}

/**
 * Uninstall an installed skill dependency
 */
export async function uninstallSkill(params: SkillUninstallParams): Promise<SkillUninstallResult> {
  const client = getGatewayClient();
  return client.request<SkillUninstallResult>("skills.uninstall", params, {
    timeout: params.timeoutMs ?? 120000,
  });
}
