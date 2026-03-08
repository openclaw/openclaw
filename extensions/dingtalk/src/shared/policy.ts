/**
 * DM 策略引擎
 *
 * 实现 open/pairing/allowlist 策略检查
 */

/**
 * DM 策略类型
 * - open: 允许所有单聊消息
 * - pairing: 配对模式（允许所有，配对逻辑由上层处理）
 * - allowlist: 仅允许白名单中的发送者
 */
export type DmPolicyType = "open" | "pairing" | "allowlist";

/**
 * 策略检查结果
 */
export interface PolicyCheckResult {
  /** 是否允许处理该消息 */
  allowed: boolean;
  /** 拒绝原因（如果被拒绝） */
  reason?: string;
}

/**
 * DM 策略检查参数
 */
export interface DmPolicyCheckParams {
  /** DM 策略类型 */
  dmPolicy: DmPolicyType;
  /** 发送者 ID */
  senderId: string;
  /** 白名单（allowlist 策略时使用） */
  allowFrom?: string[];
}

/**
 * 检查单聊策略
 *
 * @param params 检查参数
 * @returns 策略检查结果
 *
 * @example
 * ```ts
 * // 开放策略
 * checkDmPolicy({ dmPolicy: "open", senderId: "user1" });
 * // => { allowed: true }
 *
 * // 白名单策略
 * checkDmPolicy({ dmPolicy: "allowlist", senderId: "user1", allowFrom: ["user1", "user2"] });
 * // => { allowed: true }
 *
 * checkDmPolicy({ dmPolicy: "allowlist", senderId: "user3", allowFrom: ["user1", "user2"] });
 * // => { allowed: false, reason: "sender user3 not in DM allowlist" }
 * ```
 */
export function checkDmPolicy(params: DmPolicyCheckParams): PolicyCheckResult {
  const { dmPolicy, senderId, allowFrom = [] } = params;

  switch (dmPolicy) {
    case "open":
      // 开放策略：允许所有单聊消息
      return { allowed: true };

    case "pairing":
      // 配对策略：允许所有单聊消息（配对逻辑由上层处理）
      return { allowed: true };

    case "allowlist":
      // 白名单策略：仅允许 allowFrom 中的发送者
      if (allowFrom.includes(senderId)) {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: `sender ${senderId} not in DM allowlist`,
      };

    default:
      return { allowed: true };
  }
}

/**
 * 群组策略引擎
 *
 * 实现 open/allowlist/disabled 策略检查
 */

/**
 * 群组策略类型
 * - open: 允许所有群聊消息
 * - allowlist: 仅允许白名单中的群组
 * - disabled: 禁用所有群聊消息
 */
export type GroupPolicyType = "open" | "allowlist" | "disabled";

/**
 * 群组策略检查参数
 */
export interface GroupPolicyCheckParams {
  /** 群组策略类型 */
  groupPolicy: GroupPolicyType;
  /** 会话 ID（群组 ID） */
  conversationId: string;
  /** 群组白名单（allowlist 策略时使用） */
  groupAllowFrom?: string[];
  /** 是否要求 @提及机器人 */
  requireMention: boolean;
  /** 是否 @提及了机器人 */
  mentionedBot: boolean;
}

/**
 * 检查群聊策略
 *
 * @param params 检查参数
 * @returns 策略检查结果
 *
 * @example
 * ```ts
 * // 禁用策略
 * checkGroupPolicy({ groupPolicy: "disabled", conversationId: "g1", requireMention: false, mentionedBot: false });
 * // => { allowed: false, reason: "group messages disabled" }
 *
 * // 开放策略 + 要求 @提及
 * checkGroupPolicy({ groupPolicy: "open", conversationId: "g1", requireMention: true, mentionedBot: false });
 * // => { allowed: false, reason: "message did not mention bot" }
 *
 * // 白名单策略
 * checkGroupPolicy({ groupPolicy: "allowlist", conversationId: "g1", groupAllowFrom: ["g1"], requireMention: false, mentionedBot: false });
 * // => { allowed: true }
 * ```
 */
export function checkGroupPolicy(params: GroupPolicyCheckParams): PolicyCheckResult {
  const { groupPolicy, conversationId, groupAllowFrom = [], requireMention, mentionedBot } = params;

  // 首先检查群聊策略
  switch (groupPolicy) {
    case "disabled":
      // 禁用策略：拒绝所有群聊消息
      return {
        allowed: false,
        reason: "group messages disabled",
      };

    case "allowlist":
      // 白名单策略：仅允许 groupAllowFrom 中的群组
      if (!groupAllowFrom.includes(conversationId)) {
        return {
          allowed: false,
          reason: `group ${conversationId} not in allowlist`,
        };
      }
      break;

    case "open":
      // 开放策略：允许所有群聊
      break;

    default:
      break;
  }

  // 然后检查 @提及要求
  if (requireMention && !mentionedBot) {
    return {
      allowed: false,
      reason: "message did not mention bot",
    };
  }

  return { allowed: true };
}
