# 动态 Agent 路由实施方案

参考 `openclaw-plugin-wecom/dynamic-agent.js` 实现，为 `@yanhaidao/wecom` 添加按用户/群隔离的动态 Agent 功能。

## 1. 目标

- 每个用户/群组使用独立的 Agent 实例
- 自动将动态 Agent 添加到 `agents.list`
- 完全向后兼容（默认关闭）

## 2. 配置设计

### 2.1 类型定义 (src/types/config.ts)

```typescript
/** 动态 Agent 配置 */
export type WecomDynamicAgentsConfig = {
    /** 是否启用动态 Agent */
    enabled?: boolean;
    /** 私聊：是否为每个用户创建独立 Agent */
    dmCreateAgent?: boolean;
    /** 群聊：是否启用动态 Agent */
    groupEnabled?: boolean;
    /** 管理员列表（绕过动态路由，使用主 Agent） */
    adminUsers?: string[];
};

export type WecomConfig = {
    enabled?: boolean;
    bot?: WecomBotConfig;
    agent?: WecomAgentConfig;
    media?: WecomMediaConfig;
    network?: WecomNetworkConfig;
    dynamicAgents?: WecomDynamicAgentsConfig;  // 新增
};
```

### 2.2 Schema 定义 (src/config/schema.ts)

```typescript
const dynamicAgentsSchema = z.object({
    enabled: z.boolean().optional(),
    dmCreateAgent: z.boolean().optional(),
    groupEnabled: z.boolean().optional(),
    adminUsers: z.array(z.string()).optional(),
}).optional();

export const WecomConfigSchema = z.object({
    enabled: z.boolean().optional(),
    bot: botSchema,
    agent: agentSchema,
    media: mediaSchema,
    network: networkSchema,
    dynamicAgents: dynamicAgentsSchema,  // 新增
});
```

## 3. 核心实现 (src/dynamic-agent.ts)

```typescript
import type { OpenClawConfig } from "openclaw/plugin-sdk";

export interface DynamicAgentConfig {
    enabled: boolean;
    dmCreateAgent: boolean;
    groupEnabled: boolean;
    adminUsers: string[];
}

/**
 * 读取动态 Agent 配置（带默认值）
 */
export function getDynamicAgentConfig(config: OpenClawConfig): DynamicAgentConfig {
    const dynamicAgents = (config as any)?.channels?.wecom?.dynamicAgents;
    return {
        enabled: dynamicAgents?.enabled ?? false,
        dmCreateAgent: dynamicAgents?.dmCreateAgent ?? true,
        groupEnabled: dynamicAgents?.groupEnabled ?? true,
        adminUsers: dynamicAgents?.adminUsers ?? [],
    };
}

/**
 * 生成动态 Agent ID
 * 算法：wecom-{type}-{sanitizedPeerId}
 * type: dm | group
 */
export function generateAgentId(chatType: "dm" | "group", peerId: string): string {
    const sanitized = String(peerId)
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "_");
    return `wecom-${chatType}-${sanitized}`;
}

/**
 * 检查是否应该使用动态 Agent
 */
export function shouldUseDynamicAgent(params: {
    chatType: "dm" | "group";
    senderId: string;
    config: OpenClawConfig;
}): boolean {
    const { chatType, senderId, config } = params;
    const dynamicConfig = getDynamicAgentConfig(config);

    if (!dynamicConfig.enabled) {
        return false;
    }

    // 管理员绕过动态路由
    const sender = String(senderId).trim().toLowerCase();
    const isAdmin = dynamicConfig.adminUsers.some(
        admin => admin.trim().toLowerCase() === sender
    );
    if (isAdmin) {
        return false;
    }

    if (chatType === "group") {
        return dynamicConfig.groupEnabled;
    }
    return dynamicConfig.dmCreateAgent;
}

/**
 * 内存中已确保的 Agent ID（避免重复写入）
 */
const ensuredDynamicAgentIds = new Set<string>();

/**
 * 写入队列（避免并发冲突）
 */
let ensureDynamicAgentWriteQueue: Promise<void> = Promise.resolve();

/**
 * 将动态 Agent 添加到 agents.list
 */
export async function ensureDynamicAgentListed(
    agentId: string,
    runtime: { config?: { loadConfig?: () => any; writeConfigFile?: (cfg: any) => Promise<void> } }
): Promise<void> {
    const normalizedId = String(agentId).trim().toLowerCase();
    if (!normalizedId) return;
    if (ensuredDynamicAgentIds.has(normalizedId)) return;

    const configRuntime = runtime?.config;
    if (!configRuntime?.loadConfig || !configRuntime?.writeConfigFile) return;

    ensureDynamicAgentWriteQueue = ensureDynamicAgentWriteQueue
        .then(async () => {
            if (ensuredDynamicAgentIds.has(normalizedId)) return;

            const latestConfig = configRuntime.loadConfig!();
            if (!latestConfig || typeof latestConfig !== "object") return;

            const changed = upsertAgentIdOnlyEntry(latestConfig, normalizedId);
            if (changed) {
                await configRuntime.writeConfigFile!(latestConfig);
                console.log(`[wecom] 动态 Agent 已添加: ${normalizedId}`);
            }

            ensuredDynamicAgentIds.add(normalizedId);
        })
        .catch((err) => {
            console.warn(`[wecom] 动态 Agent 添加失败: ${normalizedId}`, err);
        });

    await ensureDynamicAgentWriteQueue;
}

/**
 * 将 Agent ID 插入 agents.list（如果不存在）
 */
function upsertAgentIdOnlyEntry(cfg: any, agentId: string): boolean {
    if (!cfg.agents || typeof cfg.agents !== "object") {
        cfg.agents = {};
    }

    const currentList: Array<{ id: string }> = Array.isArray(cfg.agents.list) ? cfg.agents.list : [];
    const existingIds = new Set(
        currentList
            .map((entry) => entry?.id?.trim().toLowerCase())
            .filter(Boolean)
    );

    let changed = false;
    const nextList = [...currentList];

    // 首次创建时保留 main 作为默认
    if (nextList.length === 0) {
        nextList.push({ id: "main" });
        existingIds.add("main");
        changed = true;
    }

    if (!existingIds.has(agentId.toLowerCase())) {
        nextList.push({ id: agentId });
        changed = true;
    }

    if (changed) {
        cfg.agents.list = nextList;
    }

    return changed;
}
```

## 4. 路由拦截点修改

### 4.1 Bot 模式 (src/monitor.ts)

在 `startAgentForStream` 函数中，路由解析后注入动态 Agent：

```typescript
// 约第 923 行，路由解析后
const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "wecom",
    accountId: account.accountId,
    peer: { kind: chatType === "group" ? "group" : "dm", id: chatId },
});

// ===== 动态 Agent 注入开始 =====
import { shouldUseDynamicAgent, generateAgentId, ensureDynamicAgentListed } from "./dynamic-agent.js";

const useDynamicAgent = shouldUseDynamicAgent({
    chatType: chatType === "group" ? "group" : "dm",
    senderId: userid,
    config,
});

if (useDynamicAgent) {
    const targetAgentId = generateAgentId(
        chatType === "group" ? "group" : "dm",
        chatId
    );

    // 覆盖路由
    route.agentId = targetAgentId;
    route.sessionKey = `agent:${targetAgentId}:${chatType === "group" ? "group" : "dm"}:${chatId}`;

    // 异步添加到 agents.list（不阻塞）
    ensureDynamicAgentListed(targetAgentId, core).catch(() => {});
}
// ===== 动态 Agent 注入结束 =====
```

### 4.2 Agent 模式 (src/agent/handler.ts)

在 `processAgentMessage` 函数中，路由解析后注入动态 Agent：

```typescript
// 约第 438 行，路由解析后
const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "wecom",
    accountId: agent.accountId,
    peer: { kind: isGroup ? "group" : "dm", id: peerId },
});

// ===== 动态 Agent 注入开始 =====
import { shouldUseDynamicAgent, generateAgentId, ensureDynamicAgentListed } from "../dynamic-agent.js";

const useDynamicAgent = shouldUseDynamicAgent({
    chatType: isGroup ? "group" : "dm",
    senderId: fromUser,
    config,
});

if (useDynamicAgent) {
    const targetAgentId = generateAgentId(
        isGroup ? "group" : "dm",
        peerId
    );

    // 覆盖路由
    route.agentId = targetAgentId;
    route.sessionKey = `agent:${targetAgentId}:${isGroup ? "group" : "dm"}:${peerId}`;

    // 异步添加到 agents.list
    ensureDynamicAgentListed(targetAgentId, core).catch(() => {});
}
// ===== 动态 Agent 注入结束 =====
```

## 5. 配置示例

```bash
# 启用动态 Agent
openclaw config set channels.wecom.dynamicAgents.enabled true

# 私聊为每个用户创建独立 Agent（默认 true）
openclaw config set channels.wecom.dynamicAgents.dmCreateAgent true

# 群聊启用动态 Agent（默认 true）
openclaw config set channels.wecom.dynamicAgents.groupEnabled true

# 设置管理员（管理员使用主 Agent）
openclaw config set channels.wecom.dynamicAgents.adminUsers '["admin1","admin2"]'
```

生成的配置结构：

```json
{
  "channels": {
    "wecom": {
      "enabled": true,
      "bot": { ... },
      "agent": { ... },
      "dynamicAgents": {
        "enabled": true,
        "dmCreateAgent": true,
        "groupEnabled": true,
        "adminUsers": ["admin1"]
      }
    }
  },
  "agents": {
    "list": [
      { "id": "main" },
      { "id": "wecom-dm-zhangsan" },
      { "id": "wecom-group-wr123456" }
    ]
  }
}
```

## 6. Agent ID 生成规则

| 场景 | Peer ID | 生成的 Agent ID |
|------|---------|-----------------|
| 私聊 | zhangsan | `wecom-dm-zhangsan` |
| 群聊 | wr123456 | `wecom-group-wr123456` |
| 特殊字符 | zhang.san | `wecom-dm-zhang_san` |
| 大写 | ZhangSan | `wecom-dm-zhangsan` |

## 7. 实现步骤

1. **新增文件**
   - `src/dynamic-agent.ts` - 核心逻辑

2. **修改文件**
   - `src/types/config.ts` - 添加 `WecomDynamicAgentsConfig` 类型
   - `src/config/schema.ts` - 添加 `dynamicAgentsSchema`
   - `src/monitor.ts` - Bot 模式路由拦截
   - `src/agent/handler.ts` - Agent 模式路由拦截

3. **测试验证**
   - 未启用时行为不变
   - 启用后每个用户有独立会话
   - 管理员正确使用主 Agent
   - 自动写入 agents.list

## 8. 向后兼容性

- `dynamicAgents.enabled` 默认为 `false`，不启用功能
- 未配置时保持原有行为（所有用户使用同一 Agent）
- 管理员可继续使用 `main` Agent
