/**
 * robot-config-loader.ts — 加载 claworks.robot.json 配置文件
 *
 * 搜索顺序：
 * 1. 参数指定路径
 * 2. 环境变量 CLAWORKS_ROBOT_CONFIG
 * 3. 当前目录 claworks.robot.json
 * 4. ~/.claworks/robot.json
 * 5. 使用默认配置
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ClaworksRobotConfig } from "./config-types.js";

export type RobotJsonCapabilities = {
  auto_learn?: boolean;
  proactive?: boolean;
  a2a_enabled?: boolean;
  max_concurrent_playbooks?: number;
};

export type RobotJsonOwner = {
  user_id?: string;
  name?: string;
  channel?: string;
};

export type RobotJsonLlm = {
  default_model?: string;
  classification_model?: string;
  reasoning_model?: string;
};

export type RobotJsonNotifications = {
  default_channel?: string;
  throttle_per_minute?: number;
};

export type RobotJsonBehavior = {
  constitution_tier?: "minimal" | "standard" | "strict";
  auto_approve_low_risk?: boolean;
  hitl_timeout_hours?: number;
};

/** claworks.robot.json 文件的完整结构 */
export type RobotJson = {
  $schema?: string;
  id?: string;
  name?: string;
  version?: string;
  role?: string;
  organization?: string;
  domain?: string;
  language?: string;
  timezone?: string;
  owner?: RobotJsonOwner;
  admins?: string[];
  operators?: string[];
  capabilities?: RobotJsonCapabilities;
  packs?: string[];
  connectors?: string[];
  llm?: RobotJsonLlm;
  notifications?: RobotJsonNotifications;
  behavior?: RobotJsonBehavior;
  description?: string;
  introduction?: string;
};

/** 将 RobotJson 合并到 ClaworksRobotConfig 的子集 */
function robotJsonToConfig(json: RobotJson): Partial<ClaworksRobotConfig> {
  const config: Partial<ClaworksRobotConfig> = {};

  if (json.name || json.role || json.organization || json.domain || json.language) {
    config.robot = {
      name: json.name,
      role: json.role as ClaworksRobotConfig["robot"] extends infer R
        ? R extends { role?: infer T }
          ? T
          : never
        : never,
      organization: json.organization,
      domain: json.domain,
      language: json.language,
      owner_user_id: json.owner?.user_id,
      owner_name: json.owner?.name,
      proactive: json.capabilities?.proactive,
      auto_learn: json.capabilities?.auto_learn,
    };
  }

  if (json.capabilities?.a2a_enabled !== undefined) {
    config.a2a = { enabled: json.capabilities.a2a_enabled };
  }

  if (json.capabilities?.max_concurrent_playbooks) {
    config.kernel = {
      playbook_concurrency: json.capabilities.max_concurrent_playbooks,
    };
  }

  if (json.behavior) {
    const hitlHours = json.behavior.hitl_timeout_hours;
    if (hitlHours !== undefined) {
      config.kernel = {
        ...config.kernel,
        hitl_timeout_seconds: hitlHours * 3600,
      };
    }
  }

  if (json.packs && json.packs.length > 0) {
    config.packs = { installed: json.packs };
  }

  return config;
}

function tryLoadJson(filePath: string): RobotJson | null {
  try {
    if (!existsSync(filePath)) {
      return null;
    }
    const raw = readFileSync(filePath, "utf8");
    return JSON.parse(raw) as RobotJson;
  } catch {
    return null;
  }
}

/**
 * 加载 claworks.robot.json 并将配置合并到 ClaworksRobotConfig。
 *
 * @param configPath 可选的明确路径
 * @returns 部分 ClaworksRobotConfig（只包含 robot.json 中定义的字段）
 */
export async function loadRobotConfig(configPath?: string): Promise<{
  config: Partial<ClaworksRobotConfig>;
  source: string;
  raw: RobotJson | null;
}> {
  const candidates: Array<{ path: string; label: string }> = [];

  if (configPath) {
    candidates.push({ path: resolve(configPath), label: "explicit" });
  }

  const envPath = process.env.CLAWORKS_ROBOT_CONFIG;
  if (envPath) {
    candidates.push({ path: resolve(envPath), label: "env:CLAWORKS_ROBOT_CONFIG" });
  }

  candidates.push({ path: resolve("claworks.robot.json"), label: "cwd" });
  candidates.push({ path: join(homedir(), ".claworks", "robot.json"), label: "home" });

  for (const { path, label } of candidates) {
    const json = tryLoadJson(path);
    if (json) {
      return {
        config: robotJsonToConfig(json),
        source: label,
        raw: json,
      };
    }
  }

  return { config: {}, source: "default", raw: null };
}

/**
 * 将 robot.json 原始对象转换为可读的摘要文本（用于 KB 摄入）。
 */
export function robotJsonToSummary(json: RobotJson): string {
  const lines: string[] = [
    `# 机器人配置摘要`,
    ``,
    `- **ID**: ${json.id ?? "未设置"}`,
    `- **名称**: ${json.name ?? "未设置"}`,
    `- **版本**: ${json.version ?? "1.0.0"}`,
    `- **角色**: ${json.role ?? "通用助手"}`,
    `- **组织**: ${json.organization ?? "未设置"}`,
    `- **业务域**: ${json.domain ?? "通用"}`,
    `- **语言**: ${json.language ?? "zh-CN"}`,
    ``,
    `## 能力配置`,
    `- 自动学习: ${json.capabilities?.auto_learn ? "开启" : "关闭"}`,
    `- 主动模式: ${json.capabilities?.proactive ? "开启" : "关闭"}`,
    `- A2A 协作: ${json.capabilities?.a2a_enabled ? "开启" : "关闭"}`,
    ``,
    `## 已安装 Pack`,
    ...(json.packs ?? ["base"]).map((p) => `- ${p}`),
  ];

  if (json.description) {
    lines.push(``, `## 描述`, json.description);
  }

  if (json.introduction) {
    lines.push(``, `## 自我介绍`, json.introduction);
  }

  return lines.join("\n");
}
