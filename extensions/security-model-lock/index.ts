import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type {
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookToolContext,
  PluginHookBeforeModelResolveEvent,
  PluginHookBeforeModelResolveResult,
  PluginHookMessageSendingEvent,
  PluginHookMessageSendingResult,
  PluginHookMessageContext,
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
  /**
   * 触发锁定的 runId。
   * before_tool_call 阶段 2 只在同一个 run 内 block 工具调用，
   * 避免后续 run（用户重新发送请求）的合法工具调用被误 block。
   */
  lockRunId?: string;
  /**
   * 当本次 run 中首次触发锁定时置为 true。
   * message_sending hook 消费后立即清除，确保替换通知只发送一次。
   */
  pendingNotice: boolean;
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
      "⚠️ 检测到敏感 skill 调用，会话已切换并固定为安全模型，请重新输入。切换其他模型请使用 /new 或 /reset命令重置会话。",
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
  runId?: string;
}): SecureModelLockState {
  const state: SecureModelLockState = {
    lockedAt: Date.now(),
    reason: params.reason,
    triggeredBySkill: params.triggeredBySkill,
    // 记录触发锁定的 runId，用于限制阶段 2 只在同一 run 内 block
    lockRunId: params.runId,
    // 标记需要在本次 run 的出站消息中发送一次锁定通知
    pendingNotice: true,
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
  // before_tool_call hook - 两阶段拦截：
  //   阶段 1：首次检测到 read 敏感 skill → 锁定会话并阻断本次工具调用。
  //   阶段 2：会话已锁定 → 阻断所有后续工具调用，强制 LLM 立即停止执行，
  //           避免继续调用 web_search/exec/process 等工具绕过锁定。
  //           message_sending hook 会在 LLM 生成最终回复时将其替换为通知文本。
  // ============================================================================
  api.on("before_tool_call", (event, ctx): PluginHookBeforeToolCallResult | void => {
    const { toolName, params } = event;
    const { sessionKey, runId } = ctx;

    api.logger.debug(`security-model-lock: before_tool_call: toolName=${toolName}, sessionKey=${sessionKey}`);

    // ── 阶段 2：会话已锁定，且当前仍在触发锁定的同一 run 内 → 阻断工具调用 ──
    // 只在同一 runId 内 block，避免用户重新发送请求后的合法工具调用被误 block。
    if (isSessionLocked(sessionKey)) {
      const lockState = getLockState(sessionKey);
      if (lockState?.lockRunId && lockState.lockRunId === runId) {
        api.logger.info(
          `security-model-lock: session ${sessionKey} is locked, blocking tool call: ${toolName}`,
        );
        // 阻断并给出简短原因，让 LLM 停止工具调用；
        // 实际的用户通知文本由 message_sending hook 替换。
        return {
          block: true,
          blockReason: "当前会话已触发敏感skill，请停止所有工具调用并回复用户。",
        };
      }
      // 不同 run（用户重新发送请求）：只做模型切换，不 block 工具调用
    }

    // ── 阶段 1：检测 read 工具是否读取敏感 skill 文件 ──────────────────────
    // 如果会话已锁定（来自之前的 run），跳过阶段 1，避免安全模型在新 run 中
    // 读取 SKILL.md 时被误判为再次触发敏感 skill，导致重复锁定。
    if (isSessionLocked(sessionKey)) {
      return;
    }

    if (toolName.toLowerCase() !== "read") {
      return;
    }

    const filePath = (params?.file_path as string | undefined) ?? (params?.path as string | undefined);
    api.logger.debug(`security-model-lock: read tool file_path=${filePath}`);

    if (!filePath || typeof filePath !== "string") {
      api.logger.debug(`security-model-lock: no valid file_path, skipping`);
      return;
    }

    const matchedSkill = checkIfSensitiveSkillPath(filePath, sensitiveSkillNames, skillsDirs, api.logger);
    api.logger.debug(`security-model-lock: checkIfSensitiveSkillPath result: ${matchedSkill}`);

    if (!matchedSkill) {
      return;
    }

    api.logger.info(
      `security-model-lock: sensitive skill detected: ${matchedSkill} via read ${filePath} (session: ${sessionKey}, run: ${runId})`,
    );

    // 锁定会话，pendingNotice=true 让 message_sending hook 替换 LLM 生成的回复
    // 记录 runId 以便阶段 2 只在同一 run 内 block 工具调用
    lockSession({
      sessionKey: sessionKey!,
      reason: `Sensitive skill "${matchedSkill}" was accessed via read tool`,
      triggeredBySkill: matchedSkill,
      runId: runId,
    });

    api.logger.info(
      `security-model-lock: session ${sessionKey} locked, blocking tool call`,
    );

    // 阻断工具调用；LLM 会根据 blockReason 生成回复，
    // 该回复随后被 message_sending hook 替换为统一的 lockNotice。
    return {
      block: true,
      blockReason: `检测到敏感 skill "${matchedSkill}" 初次被读写，已切换到安全模型，需要暂停本次任务并告知用户，引导用户重新提问。`,
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
  // message_sending hook - 拦截并替换本次 run 触发锁定后的第一条出站消息
  //
  // 时机：LLM 生成回复后、消息实际发送给用户之前（同步等待，可修改内容）。
  // 目的：无论 LLM 根据 blockReason 生成了什么文本，都统一替换为配置的
  //       lockNotice，确保用户收到准确、一致的安全提示。
  // ============================================================================
  api.on(
    "message_sending",
    (
      event: PluginHookMessageSendingEvent,
      ctx: PluginHookMessageContext,
    ): PluginHookMessageSendingResult | void => {
      // message_sending ctx 不携带 sessionKey；通过遍历锁定表找到有 pendingNotice 的会话。
      // 由于单次 run 是串行的，同一时刻最多只有一个会话处于 pendingNotice 状态。
      for (const [, state] of sessionLocks) {
        if (!state.pendingNotice) {
          continue;
        }
        // 消费标志，保证只替换一次
        state.pendingNotice = false;

        const skillLabel = state.triggeredBySkill ? `"${state.triggeredBySkill}"` : "敏感";
        const notice =
          config.lockNotice ??
          `⚠️ 检测到敏感 skill 调用，会话已切换并固定为安全模型，请重新输入。切换其他模型请使用 /new 或 /reset命令重置会话。`;

        api.logger.info(
          `security-model-lock: intercepting outbound message, replacing with lock notice (skill=${state.triggeredBySkill ?? "unknown"})`,
        );

        return { content: notice };
      }
    },
  );

  // ============================================================================
  // session_start / before_reset hook - 清理会话的锁定状态
  // ============================================================================
  api.on("session_start", (event, ctx) => {
    const { sessionKey } = ctx;
    if (sessionKey) {
      // 新会话开始时，清除该会话的锁定状态
      const wasLocked = isSessionLocked(sessionKey);
      if (wasLocked) {
        unlockSession(sessionKey);
        api.logger.info(`security-model-lock: session ${sessionKey} lock cleared on new session start`);
      }
    }
  });

  api.on("before_reset", (event, ctx) => {
    const { sessionKey } = ctx;
    if (sessionKey) {
      // 会话重置时，清除该会话的锁定状态
      const wasLocked = isSessionLocked(sessionKey);
      if (wasLocked) {
        unlockSession(sessionKey);
        api.logger.info(`security-model-lock: session ${sessionKey} lock cleared on before_reset`);
      }
    }
  });
}
