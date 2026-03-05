import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type {
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookToolContext,
  PluginHookBeforeModelResolveEvent,
  PluginHookBeforeModelResolveResult,
  PluginHookAgentContext,
} from "openclaw/plugin-sdk/types";
import fs from "node:fs";
import path from "node:path";

/**
 * 安全模型锁定插件
 *
 * 功能：
 * 1. 从 skills 目录读取 SKILL.md 文件，识别敏感 skills
 * 2. 在 before_tool_call hook 中检测 read 工具是否读取敏感 skill 文件
 * 3. 阻断工具调用并锁定会话
 * 4. 下次用户输入时自动切换到安全模型
 */

// 会话锁定状态存储（内存）
const sessionLocks = new Map<string, SecureModelLockState>();

type SecureModelLockState = {
  lockedAt: number;
  reason: string;
  triggeredBySkill?: string;
};

// 插件配置 Schema
type SecurityModelLockConfig = {
  /** 敏感 skill 名称列表（会匹配 SKILL.md 的 name 字段） */
  sensitiveSkills?: string[];
  /** 安全模型配置 */
  secureModel?: {
    provider: string;
    model: string;
  };
  /** 是否启用锁定（默认 true） */
  enabled?: boolean;
  /** 锁定提示消息 */
  lockNotice?: string;
  /** Skills 目录路径（可选，默认自动检测） */
  skillsDir?: string;
};

/**
 * 解析插件配置
 */
function parseConfig(api: OpenClawPluginApi): SecurityModelLockConfig {
  const config = api.pluginConfig as SecurityModelLockConfig | undefined;
  return {
    sensitiveSkills: config?.sensitiveSkills ?? ["weather"],
    secureModel: config?.secureModel ?? {
      provider: "local",
      model: "safety-model",
    },
    enabled: config?.enabled ?? true,
    lockNotice:
      config?.lockNotice ??
      "检测到敏感 skill 调用，已切换到安全模型。会话已锁定，无法切换回其他模型。",
  };
}

/**
 * 检查会话是否已锁定
 */
function isSessionLocked(sessionKey?: string): boolean {
  if (!sessionKey) {
    return false;
  }
  const state = sessionLocks.get(sessionKey);
  return state != null;
}

/**
 * 获取锁定状态
 */
function getLockState(sessionKey?: string): SecureModelLockState | undefined {
  if (!sessionKey) {
    return undefined;
  }
  return sessionLocks.get(sessionKey);
}

/**
 * 锁定会话
 */
function lockSession(params: {
  sessionKey: string;
  reason: string;
  triggeredBySkill?: string;
}): SecureModelLockState {
  const state: SecureModelLockState = {
    lockedAt: Date.now(),
    reason: params.reason,
    triggeredBySkill: params.triggeredBySkill,
  };
  sessionLocks.set(params.sessionKey, state);
  return state;
}

/**
 * 解锁会话
 */
function unlockSession(sessionKey?: string): boolean {
  if (!sessionKey) {
    return false;
  }
  return sessionLocks.delete(sessionKey);
}

/**
 * 解析 skill md 文件，提取 name 字段
 */
function parseSkillNameFromMarkdown(content: string): string | null {
  const nameMatch = content.match(/^name:\s*(.+)\s*$/m);
  return nameMatch?.[1]?.trim() ?? null;
}

/**
 * 扫描 skills 目录，返回 skill 名称集合（小写）
 */
function scanSkillsDirs(skillsDirs: string[]): Set<string> {
  const skillsSet = new Set<string>();

  for (const dir of skillsDirs) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        const skillMdPath = path.join(dir, entry.name, "SKILL.md");
        try {
          const content = fs.readFileSync(skillMdPath, "utf-8");
          const skillName = parseSkillNameFromMarkdown(content);
          if (skillName) {
            skillsSet.add(skillName.toLowerCase());
          }
        } catch {
          // Skip if SKILL.md doesn't exist or can't be read
        }
      }
    } catch {
      // Skip if directory doesn't exist
    }
  }

  return skillsSet;
}

/**
 * 获取可能的 skills 目录列表
 */
function getPossibleSkillsDirs(api: OpenClawPluginApi, config: SecurityModelLockConfig): string[] {
  const dirs: string[] = [];

  try {
    // 1. 当前工作目录的 skills/
    const cwd = process.cwd();
    dirs.push(path.join(cwd, "skills"));

    // 2. 用户 home 目录的 .openclaw/skills/
    const homeDir = process.env.HOME || process.env.USERPROFILE || "";
    if (homeDir) {
      dirs.push(path.join(homeDir, ".openclaw", "skills"));
    }

    // 3. 配置的 skillsDir
    if (config.skillsDir) {
      dirs.push(config.skillsDir);
    }
  } catch {
    // ignore
  }

  return dirs;
}

/**
 * 检查文件路径是否属于敏感 skill 目录
 * 返回匹配的 skill 名称，如果不匹配返回 null
 */
function checkIfSensitiveSkillPath(
  filePath: string,
  sensitiveSkillNames: Set<string>,
  skillsDirs: string[],
  logger: OpenClawPluginApi["logger"],
): string | null {
  const normalizedPath = path.normalize(filePath);
  logger.debug(`security-model-lock: checkIfSensitiveSkillPath: filePath=${filePath}, normalizedPath=${normalizedPath}, skillsDirs=${JSON.stringify(skillsDirs)}`);

  for (const dir of skillsDirs) {
    const normalizedDir = path.normalize(dir);

    logger.debug(`security-model-lock: checking dir: ${normalizedDir}, startsWith=${normalizedPath.startsWith(normalizedDir)}`);

    // 检查路径是否以 skills 目录开头
    if (!normalizedPath.startsWith(normalizedDir)) {
      continue;
    }

    // 提取 skill 目录名
    // 例如：/path/to/skills/weather/SKILL.md -> weather
    const relativePath = path.relative(normalizedDir, normalizedPath);
    logger.debug(`security-model-lock: relativePath=${relativePath}`);

    const parts = relativePath.split(path.sep);
    logger.debug(`security-model-lock: parts=${JSON.stringify(parts)}`);

    if (parts.length >= 1) {
      const skillDirName = parts[0].toLowerCase();
      logger.debug(`security-model-lock: skillDirName=${skillDirName}, isSensitive=${sensitiveSkillNames.has(skillDirName)}`);

      if (sensitiveSkillNames.has(skillDirName)) {
        return skillDirName;
      }
    }
  }

  return null;
}

export default function register(api: OpenClawPluginApi) {
  const config = parseConfig(api);

  if (!config.enabled) {
    api.logger.info("security-model-lock: plugin disabled by config");
    return;
  }

  api.logger.info(
    `security-model-lock: initialized (sensitiveSkills: ${config.sensitiveSkills?.join(", ") || "none"})`,
  );

  // 敏感 skill 名称集合（小写）
  const sensitiveSkillNames = new Set(
    config.sensitiveSkills?.map((s) => s.toLowerCase()) ?? [],
  );

  // 获取 skills 目录列表
  const skillsDirs = getPossibleSkillsDirs(api, config);
  api.logger.info(`security-model-lock: scanning skills dirs: ${skillsDirs.join(", ")}`);

  // 扫描所有可用的 skills（用于日志）
  const allSkills = scanSkillsDirs(skillsDirs);
  const foundSensitiveSkills = [...allSkills].filter((s) => sensitiveSkillNames.has(s));

  api.logger.info(
    `security-model-lock: found ${allSkills.size} skills, monitoring ${foundSensitiveSkills.length}: ${foundSensitiveSkills.join(", ")}`,
  );

  // ============================================================================
  // before_tool_call hook - 检测 read 工具是否读取敏感 skill 文件
  // ============================================================================
  api.on("before_tool_call", (event, ctx): PluginHookBeforeToolCallResult | void => {
    const { toolName, params } = event;
    const { sessionKey, sessionId, runId } = ctx;

    api.logger.debug(`security-model-lock: before_tool_call: toolName=${toolName}, sessionKey=${sessionKey}`);

    // 只检测 read 工具
    if (toolName.toLowerCase() !== "read") {
      return;
    }

    // 检查是否有 file_path 或 path 参数（两者都可能被使用）
    const filePath = (params?.file_path as string | undefined) ?? (params?.path as string | undefined);
    api.logger.debug(`security-model-lock: read tool file_path=${filePath}`);

    if (!filePath || typeof filePath !== "string") {
      api.logger.debug(`security-model-lock: no valid file_path, skipping`);
      return;
    }

    // 检查是否读取敏感 skill 文件
    const matchedSkill = checkIfSensitiveSkillPath(filePath, sensitiveSkillNames, skillsDirs, api.logger);
    api.logger.debug(`security-model-lock: checkIfSensitiveSkillPath result: ${matchedSkill}`);

    if (!matchedSkill) {
      return;
    }

    // 检查会话是否已锁定
    const locked = isSessionLocked(sessionKey);
    if (locked) {
      api.logger.debug(
        `security-model-lock: read ${filePath} called in locked session ${sessionKey}`,
      );
      return;
    }

    api.logger.info(
      `security-model-lock: sensitive skill detected: ${matchedSkill} via read ${filePath} (session: ${sessionKey}, run: ${runId})`,
    );

    // 锁定会话
    lockSession({
      sessionKey: sessionKey!,
      reason: `Sensitive skill "${matchedSkill}" was accessed via read tool`,
      triggeredBySkill: matchedSkill,
    });

    // 阻断工具调用，提示用户重新发送消息
    return {
      block: true,
      blockReason: config.lockNotice ?? "检测到敏感 skill 调用，已切换到安全模型。请重新发送消息。",
    };
  });

  // ============================================================================
  // before_model_resolve hook - 切换模型
  // ============================================================================
  api.on("before_model_resolve", (event, ctx): PluginHookBeforeModelResolveResult | void => {
    const { sessionKey } = ctx;

    // 检查会话是否已锁定
    if (!isSessionLocked(sessionKey)) {
      return;
    }

    const lockState = getLockState(sessionKey);
    api.logger.info(
      `security-model-lock: session ${sessionKey} is locked, switching to secure model`,
    );

    // 返回安全模型配置
    return {
      providerOverride: config.secureModel?.provider,
      modelOverride: config.secureModel?.model,
    };
  });

  // ============================================================================
  // 解锁命令
  // ============================================================================
  api.registerCommand({
    name: "security-unlock",
    description: "Unlock the current session to allow switching models again",
    acceptsArgs: false,
    handler: async (ctx) => {
      const sessionKey = ctx.sessionKey;
      if (!sessionKey) {
        return { text: "Error: No active session found." };
      }

      const wasLocked = isSessionLocked(sessionKey);
      if (!wasLocked) {
        return { text: "Session is not locked." };
      }

      unlockSession(sessionKey);
      api.logger.info(`security-model-lock: session ${sessionKey} unlocked by user command`);

      return {
        text: "Session unlocked. You can now switch models again using /model <provider/model>.",
      };
    },
  });

  // ============================================================================
  // 状态查询命令
  // ============================================================================
  api.registerCommand({
    name: "security-status",
    description: "Check if the current session is locked to secure model",
    acceptsArgs: false,
    handler: async (ctx) => {
      const sessionKey = ctx.sessionKey;
      const lockState = getLockState(sessionKey);

      if (!lockState) {
        const sensitiveSkillsList = config.sensitiveSkills?.join(", ") || "none";
        return {
          text: [
            "Security Model Lock Status: Not locked",
            "",
            `Monitored skills: ${sensitiveSkillsList}`,
            `Secure model: ${config.secureModel?.provider || "not configured"}/${config.secureModel?.model || "not configured"}`,
            "",
            "Lock will be triggered when a sensitive skill file is read.",
          ].join("\n"),
        };
      }

      const triggeredBy = lockState.triggeredBySkill ? ` (triggered by: ${lockState.triggeredBySkill})` : "";
      const duration = Math.floor((Date.now() - lockState.lockedAt) / 1000);

      return {
        text: [
          "Security Model Lock Status: LOCKED",
          "",
          `Locked at: ${new Date(lockState.lockedAt).toLocaleString()}${triggeredBy}`,
          `Duration: ${duration}s`,
          `Reason: ${lockState.reason}`,
          "",
          "All model calls will use the configured secure model.",
          "Use /security-unlock to unlock this session.",
        ].join("\n"),
      };
    },
  });
}
