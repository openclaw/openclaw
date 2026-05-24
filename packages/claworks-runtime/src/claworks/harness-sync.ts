/**
 * harness-sync.ts — ClaWorks + OpenClaw Harness 双向同步
 *
 * 职责：
 * 1. 检测本机 OpenClaw 安装（~/.openclaw/agents）
 * 2. 从 OpenClaw 同步模型配置到 ClaWorks model-router
 * 3. 向 OpenClaw agent 注册 ClaWorks cw_ 工具
 *
 * 边界：
 * - 不依赖 OpenClaw SDK（runtime 包独立测试）
 * - 通过文件系统读写进行配置同步
 * - 不修改 OpenClaw 运行时，只扩展 agent tools 列表
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BRIDGE_SKILL } from "../kernel/bridge-registry.js";
import type { ClaworksRuntime } from "./runtime-types.js";

// ── 类型 ──────────────────────────────────────────────────────────────────

export type OpenClawModel = {
  id: string;
  provider: string;
  modelId: string;
  displayName?: string;
};

export type OpenClawChannel = {
  id: string;
  type: string;
  enabled?: boolean;
};

export type OpenClawAgentConfig = {
  agentId?: string;
  name?: string;
  version?: string;
  models?: OpenClawModel[];
  channels?: OpenClawChannel[];
  skills?: string[];
  tools?: Array<{ name: string; description?: string }>;
};

export type HarnessSyncResult = {
  synced: boolean;
  models_imported: number;
  skills_discovered: number;
  channels_found: number;
  recommendations: string[];
  openclaw_version?: string;
  agent_id?: string;
};

export type PushResult = {
  pushed: boolean;
  tools_registered: string[];
  target_agent_id?: string;
  error?: string;
};

export type HarnessDetectResult = {
  found: boolean;
  configPath?: string;
  agentConfigs?: Array<{ agentId: string; configPath: string; config: OpenClawAgentConfig }>;
  version?: string;
};

export type HarnessSkillEntry = {
  id: string;
  name?: string;
  description?: string;
};

export type HarnessStatusSnapshot = {
  lastSyncAt?: string;
  openclaw_found: boolean;
  openclaw_detected: boolean;
  models_synced: number;
  tools_pushed: string[];
  local_skill_count: number;
  harness_skill_count: number;
};

export type HarnessSync = {
  detectOpenClaw(): Promise<HarnessDetectResult>;
  syncFromOpenClaw(configPath: string): Promise<HarnessSyncResult>;
  pushToOpenClaw(opts?: { agentId?: string }): Promise<PushResult>;
  bidirectionalSync(): Promise<HarnessSyncResult>;
  status(): Promise<HarnessStatusSnapshot>;
};

/** 从 OpenClaw agent 配置扫描 harness 侧 skill ID（bridge.list 不可用时的 fallback） */
export async function discoverHarnessSkillsFromConfig(): Promise<HarnessSkillEntry[]> {
  const base = findOpenClawBase();
  if (!base) {
    return [];
  }

  const agents = scanAgents(base);
  const seen = new Set<string>();
  const skills: HarnessSkillEntry[] = [];

  for (const agent of agents) {
    for (const skillId of agent.config.skills ?? []) {
      if (seen.has(skillId)) {
        continue;
      }
      seen.add(skillId);
      skills.push({ id: skillId, name: skillId });
    }
  }

  return skills;
}

// ── ClaWorks 向 OpenClaw 注册的工具清单 ──────────────────────────────────

const CW_TOOLS_FOR_OPENCLAW = [
  {
    name: "cw_bridge_im_message",
    description: "通过 ClaWorks IM 桥发送消息（飞书/企微/钉钉）",
    parameters: {
      type: "object",
      required: ["channel", "recipient", "content"],
      properties: {
        channel: { type: "string", description: "渠道类型：feishu | weixin_work | dingtalk" },
        recipient: { type: "string", description: "收件人 ID" },
        content: { type: "string", description: "消息内容" },
        card_template: { type: "string", description: "卡片模板名称（可选）" },
      },
    },
  },
  {
    name: "cw_trigger_playbook",
    description: "在 ClaWorks 中触发一个 Playbook 执行",
    parameters: {
      type: "object",
      required: ["playbook_id"],
      properties: {
        playbook_id: { type: "string", description: "Playbook ID" },
        params: { type: "object", description: "Playbook 参数" },
      },
    },
  },
  {
    name: "cw_query_kb",
    description: "在 ClaWorks 知识库中语义搜索",
    parameters: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "搜索关键词" },
        top_k: { type: "integer", default: 5 },
      },
    },
  },
  {
    name: "cw_get_equipment_status",
    description: "查询工业设备状态（通过 ClaWorks 工业域能力）",
    parameters: {
      type: "object",
      properties: {
        equipment_id: { type: "string", description: "设备 ID（可选，不填返回所有）" },
      },
    },
  },
  {
    name: "cw_create_work_order",
    description: "在 ClaWorks 中创建维护工单",
    parameters: {
      type: "object",
      required: ["title", "equipment_id"],
      properties: {
        title: { type: "string" },
        equipment_id: { type: "string" },
        priority: { type: "string", enum: ["low", "medium", "high", "critical"] },
        description: { type: "string" },
      },
    },
  },
];

// ── OpenClaw 配置文件解析 ─────────────────────────────────────────────────

function tryReadJson<T>(filePath: string): T | null {
  try {
    if (!existsSync(filePath)) {
      return null;
    }
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function findOpenClawBase(): string | null {
  const candidates = [join(homedir(), ".openclaw"), join(homedir(), ".config", "openclaw")];

  // 环境变量优先
  const envBase = process.env.OPENCLAW_CONFIG_PATH;
  if (envBase) {
    candidates.unshift(envBase);
  }

  for (const base of candidates) {
    if (existsSync(base)) {
      return base;
    }
  }
  return null;
}

function scanAgents(
  base: string,
): Array<{ agentId: string; configPath: string; config: OpenClawAgentConfig }> {
  const agentsDir = join(base, "agents");
  if (!existsSync(agentsDir)) {
    return [];
  }

  const agents: Array<{ agentId: string; configPath: string; config: OpenClawAgentConfig }> = [];

  let entries: string[];
  try {
    entries = readdirSync(agentsDir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    const agentDir = join(agentsDir, entry);
    try {
      if (!statSync(agentDir).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }

    // OpenClaw agent config 可能在不同路径
    const configCandidates = [
      join(agentDir, "agent", "config.json"),
      join(agentDir, "config.json"),
    ];

    for (const cp of configCandidates) {
      const config = tryReadJson<OpenClawAgentConfig>(cp);
      if (config) {
        agents.push({ agentId: entry, configPath: cp, config: { agentId: entry, ...config } });
        break;
      }
    }
  }

  return agents;
}

// ── 同步逻辑 ──────────────────────────────────────────────────────────────

// 简单的内存状态（持久化留给 runtime DB）
let _lastSyncAt: string | undefined;
let _syncedModelsCount = 0;
let _pushedTools: string[] = [];

export function createHarnessSync(runtime: ClaworksRuntime): HarnessSync {
  return {
    async detectOpenClaw(): Promise<HarnessDetectResult> {
      const base = findOpenClawBase();
      if (!base) {
        // 尝试环境变量
        const envAgentId = process.env.OPENCLAW_AGENT_ID;
        if (envAgentId) {
          return {
            found: true,
            configPath: join(homedir(), ".openclaw"),
            agentConfigs: [
              { agentId: envAgentId, configPath: "env", config: { agentId: envAgentId } },
            ],
          };
        }
        return { found: false };
      }

      const agentConfigs = scanAgents(base);

      // 尝试读取版本
      let version: string | undefined;
      for (const vp of [join(base, "version"), join(base, ".version")]) {
        if (existsSync(vp)) {
          try {
            version = readFileSync(vp, "utf8").trim();
          } catch {
            /* ignore */
          }
          break;
        }
      }

      return { found: true, configPath: base, agentConfigs, version };
    },

    async syncFromOpenClaw(configPath: string): Promise<HarnessSyncResult> {
      const result: HarnessSyncResult = {
        synced: false,
        models_imported: 0,
        skills_discovered: 0,
        channels_found: 0,
        recommendations: [],
      };

      try {
        const agents = scanAgents(configPath);
        if (agents.length === 0) {
          result.recommendations.push(
            "未找到 OpenClaw Agent 配置，请确认 ~/.openclaw/agents/ 目录",
          );
          return result;
        }

        // 使用第一个（或 OPENCLAW_AGENT_ID 指定的）agent
        const targetAgentId = process.env.OPENCLAW_AGENT_ID;
        const agent =
          (targetAgentId ? agents.find((a) => a.agentId === targetAgentId) : undefined) ??
          agents[0];

        if (!agent) {
          return result;
        }

        result.agent_id = agent.agentId;

        // 导入模型配置
        if (agent.config.models && agent.config.models.length > 0) {
          for (const model of agent.config.models) {
            try {
              // 将 OpenClaw 模型注册到 ClaWorks model-router（通过 KB 记录）
              await runtime.kb.ingest(
                `# OpenClaw 模型：${model.displayName ?? model.id}\n- provider: ${model.provider}\n- modelId: ${model.modelId}\n- id: ${model.id}`,
                { source: "harness:openclaw_sync", namespace: "openclaw-models" },
              );
              result.models_imported++;
            } catch {
              // 单个模型失败不中断
            }
          }
        }

        // 发现技能
        if (agent.config.skills) {
          result.skills_discovered = agent.config.skills.length;
        }

        // 发现渠道
        if (agent.config.channels) {
          result.channels_found = agent.config.channels.length;
        }

        // 生成建议
        if (result.models_imported === 0) {
          result.recommendations.push(
            "OpenClaw agent 中未发现模型配置，请在 OpenClaw 中先配置 LLM Provider",
          );
        }
        if (result.channels_found === 0) {
          result.recommendations.push(
            "OpenClaw agent 中未发现渠道配置，ClaWorks 将使用独立配置的 IM 渠道",
          );
        }

        result.synced = true;
        _lastSyncAt = new Date().toISOString();
        _syncedModelsCount = result.models_imported;

        // 发布事件
        await runtime.kernel.publish("harness.sync_completed", "harness-sync", {
          agent_id: agent.agentId,
          models_imported: result.models_imported,
          skills_discovered: result.skills_discovered,
        });
      } catch (err) {
        result.recommendations.push(
          `同步失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }

      return result;
    },

    async pushToOpenClaw(opts?: { agentId?: string }): Promise<PushResult> {
      const base = findOpenClawBase();
      if (!base) {
        return { pushed: false, tools_registered: [], error: "未找到 OpenClaw 安装目录" };
      }

      const agents = scanAgents(base);
      const targetAgentId = opts?.agentId ?? process.env.OPENCLAW_AGENT_ID ?? agents[0]?.agentId;
      if (!targetAgentId) {
        return { pushed: false, tools_registered: [], error: "未找到可用的 OpenClaw Agent" };
      }

      const agentEntry = agents.find((a) => a.agentId === targetAgentId);
      if (!agentEntry) {
        return { pushed: false, tools_registered: [], error: `Agent ${targetAgentId} 未找到` };
      }

      try {
        // 读取现有配置
        const existingConfig = agentEntry.config;

        // 合并 ClaWorks 工具（不覆盖已有同名工具）
        const existingToolNames = new Set((existingConfig.tools ?? []).map((t) => t.name));
        const toolsToAdd = CW_TOOLS_FOR_OPENCLAW.filter((t) => !existingToolNames.has(t.name));

        const updatedConfig = {
          ...existingConfig,
          tools: [...(existingConfig.tools ?? []), ...toolsToAdd],
        };

        // 写回配置文件
        writeFileSync(agentEntry.configPath, JSON.stringify(updatedConfig, null, 2), "utf8");

        const registered = toolsToAdd.map((t) => t.name);
        _pushedTools = registered;

        runtime.logger?.(
          `[harness-sync] 已向 OpenClaw Agent ${targetAgentId} 注册 ${registered.length} 个 ClaWorks 工具`,
        );

        return { pushed: true, tools_registered: registered, target_agent_id: targetAgentId };
      } catch (err) {
        return {
          pushed: false,
          tools_registered: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },

    async bidirectionalSync(): Promise<HarnessSyncResult> {
      const detection = await this.detectOpenClaw();
      if (!detection.found || !detection.configPath) {
        return {
          synced: false,
          models_imported: 0,
          skills_discovered: 0,
          channels_found: 0,
          recommendations: ["未找到 OpenClaw 安装，跳过双向同步"],
        };
      }

      const syncResult = await this.syncFromOpenClaw(detection.configPath);
      const pushResult = await this.pushToOpenClaw();

      if (!pushResult.pushed && pushResult.error) {
        syncResult.recommendations.push(`推送工具失败：${pushResult.error}`);
      }

      return syncResult;
    },

    async status() {
      const openclawFound = !!(await this.detectOpenClaw()).found;
      const localSkillCount = runtime.scriptLibrary?.list().length ?? 0;
      let harnessSkillCount = 0;
      const skillBridge = runtime.bridges?.get(BRIDGE_SKILL);
      if (skillBridge?.list) {
        try {
          harnessSkillCount = (await skillBridge.list()).length;
        } catch {
          harnessSkillCount = (await discoverHarnessSkillsFromConfig()).length;
        }
      } else {
        harnessSkillCount = (await discoverHarnessSkillsFromConfig()).length;
      }

      return {
        lastSyncAt: _lastSyncAt,
        openclaw_found: openclawFound,
        openclaw_detected: openclawFound,
        models_synced: _syncedModelsCount,
        tools_pushed: _pushedTools,
        local_skill_count: localSkillCount,
        harness_skill_count: harnessSkillCount,
      };
    },
  };
}
