import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type {
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookToolContext,
  PluginHookBeforeModelResolveEvent,
  PluginHookBeforeModelResolveResult,
  PluginHookAgentContext,
} from "openclaw/plugin-sdk/types";

/**
 * 安全模型锁定插件
 *
 * 功能：
 * 1. 检测敏感工具调用（如 weather）
 * 2. 自动切换到配置的安全模型
 * 3. 锁定会话，防止切换回其他模型
 * 4. 如果已经在安全模型上则不阻断
 */

// 会话锁定状态存储（内存 + 持久化）
const sessionLocks = new Map<string, SecureModelLockState>();

type SecureModelLockState = {
  lockedAt: number;
  reason: string;
  triggeredByTool?: string;
};

// 插件配置 Schema
type SecurityModelLockConfig = {
  /** 敏感工具列表 */
  sensitiveTools?: string[];
  /** 安全模型配置 */
  secureModel?: {
    provider: string;
    model: string;
  };
  /** 是否启用锁定（默认 true） */
  enabled?: boolean;
  /** 锁定提示消息 */
  lockNotice?: string;
};

/**
 * 解析插件配置
 */
function parseConfig(api: OpenClawPluginApi): SecurityModelLockConfig {
  const config = api.config.get<SecurityModelLockConfig>();
  return {
    sensitiveTools: config?.sensitiveTools ?? ["weather"],
    secureModel: config?.secureModel ?? {
      provider: "local",
      model: "safety-model",
    },
    enabled: config?.enabled ?? true,
    lockNotice:
      config?.lockNotice ??
      "检测到敏感工具调用，已切换到安全模型。会话已锁定，无法切换回其他模型。",
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
  triggeredByTool?: string;
}): SecureModelLockState {
  const state: SecureModelLockState = {
    lockedAt: Date.now(),
    reason: params.reason,
    triggeredByTool: params.triggeredByTool,
  };
  sessionLocks.set(params.sessionKey, state);
  return state;
}

/**
 * 解锁会话（用于 /new 或 /reset 时）
 */
function unlockSession(sessionKey?: string): boolean {
  if (!sessionKey) {
    return false;
  }
  return sessionLocks.delete(sessionKey);
}

/**
 * 检查当前模型是否是安全模型
 */
function isCurrentModelSecure(
  currentProvider?: string,
  currentModel?: string,
  secureModel?: { provider: string; model: string },
): boolean {
  if (!secureModel || !currentProvider || !currentModel) {
    return false;
  }
  return (
    currentProvider.toLowerCase() === secureModel.provider.toLowerCase() &&
    currentModel.toLowerCase() === secureModel.model.toLowerCase()
  );
}

export default function register(api: OpenClawPluginApi) {
  const config = parseConfig(api);

  if (!config.enabled) {
    api.logger.info("security-model-lock: plugin disabled by config");
    return;
  }

  api.logger.info(
    `security-model-lock: initialized (sensitiveTools: ${config.sensitiveTools?.join(", ") || "none"})`,
  );

  // ============================================================================
  // before_tool_call hook - 检测敏感工具调用
  // ============================================================================
  api.on("before_tool_call", (event, ctx): PluginHookBeforeToolCallResult | void => {
    const { toolName, params: toolParams } = event;
    const { sessionKey, sessionId, runId } = ctx;

    // 检查是否已配置敏感工具列表
    const sensitiveTools = new Set(config.sensitiveTools?.map((t) => t.toLowerCase()) ?? []);
    if (!sensitiveTools.has(toolName.toLowerCase())) {
      return;
    }

    // 检查会话是否已锁定
    const locked = isSessionLocked(sessionKey);
    if (locked) {
      // 已锁定，记录日志但不重复阻断
      api.logger.debug(
        `security-model-lock: tool ${toolName} called in locked session ${sessionKey}`,
      );
      return;
    }

    api.logger.info(
      `security-model-lock: sensitive tool detected: ${toolName} (session: ${sessionKey}, run: ${runId})`,
    );

    // 锁定会话
    lockSession({
      sessionKey: sessionKey!,
      reason: `Sensitive tool "${toolName}" was called`,
      triggeredByTool: toolName,
    });

    // 记录事件
    api.runtime.events.emit({
      stream: "security",
      data: {
        type: "model_lock_triggered",
        sessionId,
        sessionKey,
        runId,
        toolName,
        lockedAt: Date.now(),
      },
    });

    // 注意：这里不阻断工具调用，只是锁定会话
    // 下一次用户输入时会切换到安全模型
    // 如果需要立即阻断，返回：
    // return { block: true, blockReason: config.lockNotice };
  });

  // ============================================================================
  // before_model_resolve hook - 切换模型
  // ============================================================================
  api.on("before_model_resolve", (event, ctx): PluginHookBeforeModelResolveResult | void => {
    const { sessionKey, sessionId } = ctx;

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
  // 可选：提供解锁命令
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
        text:
          "Session unlocked. You can now switch models again using /model <provider/model>.",
      };
    },
  });

  // ============================================================================
  // 可选：提供状态查询命令
  // ============================================================================
  api.registerCommand({
    name: "security-status",
    description: "Check if the current session is locked to secure model",
    acceptsArgs: false,
    handler: async (ctx) => {
      const sessionKey = ctx.sessionKey;
      const lockState = getLockState(sessionKey);

      if (!lockState) {
        const sensitiveToolsList = config.sensitiveTools?.join(", ") || "none";
        return {
          text: [
            "Security Model Lock Status: Not locked",
            "",
            `Monitored tools: ${sensitiveToolsList}`,
            `Secure model: ${config.secureModel?.provider || "not configured"}/${config.secureModel?.model || "not configured"}`,
            "",
            "Lock will be triggered when a sensitive tool is called.",
          ].join("\n"),
        };
      }

      const triggeredBy = lockState.triggeredByTool ? ` (triggered by: ${lockState.triggeredByTool})` : "";
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
