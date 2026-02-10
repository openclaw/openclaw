/**
 * WeCom Target Resolver (企业微信目标解析器)
 * 
 * 解析 OpenClaw 的 `to` 字段（原始目标字符串），将其转换为企业微信支持的具体接收对象。
 * 支持显式前缀 (party:, tag: 等) 和基于规则的启发式推断。
 * 
 * **关于“目标发送”与“消息记录”的对应关系 (Target vs Inbound):**
 * - **发送 (Outbound)**: 支持一对多广播 (Party/Tag)。
 *   例如发送给 `party:1`，消息会触达该部门下所有成员。
 * - **接收 (Inbound)**: 总是来自具体的 **用户 (User)** 或 **群聊 (Chat)**。
 *   当成员回复部门广播消息时，可以视为一个新的单聊会话或在该成员的现有单聊中回复。
 *   因此，Outbound Target (如 Party) 与 Inbound Source (User) 不需要也不可能 1:1 强匹配。
 *   广播是“发后即忘” (Fire-and-Forget) 的通知模式，而回复是具体的会话模式。
 */

export interface WecomTarget {
    touser?: string;
    toparty?: string;
    totag?: string;
    chatid?: string;
}

/**
 * Parses a raw target string into a WeComTarget object.
 * 解析原始目标字符串为 WeComTarget 对象。
 * 
 * 逻辑:
 * 1. 移除标准命名空间前缀 (wecom:, qywx: 等)。
 * 2. 检查显式类型前缀 (party:, tag:, group:, user:)。
 * 3. 启发式回退 (无前缀时):
 *    - 以 "wr" 或 "wc" 开头 -> Chat ID (群聊)
 *    - 纯数字 -> Party ID (部门)
 *    - 其他 -> User ID (用户)
 * 
 * @param raw - The raw target string (e.g. "party:1", "zhangsan", "wecom:wr123")
 */
export function resolveWecomTarget(raw: string | undefined): WecomTarget | undefined {
    if (!raw?.trim()) return undefined;

    // 1. Remove standard namespace prefixes (移除标准命名空间前缀)
    let clean = raw.trim().replace(/^(wecom-agent|wecom|wechatwork|wework|qywx):/i, "");

    // 2. Explicit Type Prefixes (显式类型前缀)
    if (/^party:/i.test(clean)) {
        return { toparty: clean.replace(/^party:/i, "").trim() };
    }
    if (/^dept:/i.test(clean)) {
        return { toparty: clean.replace(/^dept:/i, "").trim() };
    }
    if (/^tag:/i.test(clean)) {
        return { totag: clean.replace(/^tag:/i, "").trim() };
    }
    if (/^group:/i.test(clean)) {
        return { chatid: clean.replace(/^group:/i, "").trim() };
    }
    if (/^chat:/i.test(clean)) {
        return { chatid: clean.replace(/^chat:/i, "").trim() };
    }
    if (/^user:/i.test(clean)) {
        return { touser: clean.replace(/^user:/i, "").trim() };
    }

    // 3. Heuristics (启发式规则)

    // Chat ID typically starts with 'wr' or 'wc'
    // 群聊 ID 通常以 'wr' (外部群) 或 'wc' 开头
    if (/^(wr|wc)/i.test(clean)) {
        return { chatid: clean };
    }

    // Pure digits are likely Department IDs (Parties)
    // 纯数字优先被视为部门 ID (Parties)，方便运维配置 (如 "1" 代表根部门)
    // 如果必须要发送给纯数字 ID 的用户，请使用显式前缀 "user:1001"
    if (/^\d+$/.test(clean)) {
        return { toparty: clean };
    }

    // Default to User (默认为用户)
    return { touser: clean };
}
