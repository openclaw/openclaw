# Issue #33974 修复方案：WhatsApp 运行时配置更改被忽略

## 1. 问题根因分析

### 1.1 核心问题：闭包捕获陈旧配置

`createWebOnMessageHandler` 函数在初始化时通过 `params.cfg` 捕获了配置对象的引用：

```typescript
// src/web/auto-reply/monitor/on-message.ts 第18-32行
export function createWebOnMessageHandler(params: {
  cfg: ReturnType<typeof loadConfig>; // 初始化时传入的配置快照
  // ...
}) {
  // 返回的 handler 函数闭包中永久持有 params.cfg 的引用
  return async (msg: WebInboundMsg) => {
    // 所有下游调用都使用这个陈旧的配置快照
  };
}
```

当运行时配置被修改（如通过管理API或配置文件热重载）后，新配置不会反映到已创建的 handler 中，因为：

1. `loadConfig()` 每次调用会返回当前最新的配置
2. 但 `createWebOnMessageHandler` 只接收一次 `params.cfg`，后续所有调用都使用这个快照
3. 这导致 `requireMention` 切换、群组策略更改等配置更新被静默忽略

### 1.2 附加问题：账户特定配置丢失

**问题1：group-activation.ts 不传递 accountId**

```typescript
// src/web/auto-reply/monitor/group-activation.ts 第13-31行
export function resolveGroupPolicyFor(cfg: ReturnType<typeof loadConfig>, conversationId: string) {
  // ...
  return resolveChannelGroupPolicy({
    cfg,
    channel: "whatsapp",
    groupId: groupId ?? conversationId,
    hasGroupAllowFrom, // 从顶层 cfg.channels.whatsapp 计算
    // 缺少 accountId 参数！
  });
}
```

`resolveChannelGroupPolicy` 支持 `accountId` 参数（第329行），但 `resolveGroupPolicyFor` 没有传递它，导致非默认账户的群组策略无法正确解析。

**问题2：hasGroupAllowFrom 计算忽略账户特定覆盖**

```typescript
// src/web/auto-reply/monitor/group-activation.ts 第19-24行
const whatsappCfg = cfg.channels?.whatsapp as { groupAllowFrom?: string[]; allowFrom?: string[] };
const hasGroupAllowFrom = Boolean(
  whatsappCfg?.groupAllowFrom?.length || whatsappCfg?.allowFrom?.length,
);
```

这里只从顶层 `cfg.channels.whatsapp` 读取配置，没有考虑 `cfg.channels.whatsapp.accounts[accountId]` 中可能存在的账户特定覆盖。

### 1.3 正确模式参考

```typescript
// src/web/auto-reply/monitor/on-message.ts 第67-68行
const route = resolveAgentRoute({
  cfg: loadConfig(), // 每次调用都获取最新配置
  channel: "whatsapp",
  accountId: msg.accountId,
  // ...
});
```

这是正确的模式：每次消息处理时都调用 `loadConfig()` 获取最新配置。

## 2. 计划修改的文件列表

| 文件                                             | 行号    | 修改内容                                                                      |
| ------------------------------------------------ | ------- | ----------------------------------------------------------------------------- |
| `src/web/auto-reply/monitor/on-message.ts`       | 43      | `processMessage` 调用：改为使用 `loadConfig()`                                |
| `src/web/auto-reply/monitor/on-message.ts`       | 115-125 | `updateLastRouteInBackground` 调用：改为使用 `loadConfig()`                   |
| `src/web/auto-reply/monitor/on-message.ts`       | 127-141 | `applyGroupGating` 调用：改为使用 `loadConfig()`，并传递 `accountId`          |
| `src/web/auto-reply/monitor/on-message.ts`       | 155-163 | `maybeBroadcastMessage` 调用：改为使用 `loadConfig()`                         |
| `src/web/auto-reply/monitor/group-activation.ts` | 13-31   | `resolveGroupPolicyFor`：添加 `accountId` 参数，修复 `hasGroupAllowFrom` 计算 |
| `src/web/auto-reply/monitor/group-activation.ts` | 33-47   | `resolveGroupRequireMentionFor`：添加 `accountId` 参数                        |
| `src/web/auto-reply/monitor/group-activation.ts` | 49-63   | `resolveGroupActivationFor`：更新 `resolveGroupRequireMentionFor` 调用        |
| `src/web/auto-reply/monitor/group-gating.ts`     | 82-83   | `applyGroupGating` 中的 `resolveGroupPolicyFor` 调用：传递 `accountId`        |

## 3. 详细修复步骤

### 3.1 修改 `group-activation.ts` - 添加 accountId 支持

**修改1：更新 `resolveGroupPolicyFor` 函数签名和实现**

```typescript
// src/web/auto-reply/monitor/group-activation.ts
import { resolveWhatsAppAccount } from "../../accounts.js"; // 新增导入

export function resolveGroupPolicyFor(
  cfg: ReturnType<typeof loadConfig>,
  conversationId: string,
  accountId?: string, // 新增参数
) {
  const groupId = resolveGroupSessionKey({
    From: conversationId,
    ChatType: "group",
    Provider: "whatsapp",
  })?.id;

  // 使用 resolveWhatsAppAccount 获取账户特定配置（包含继承逻辑）
  const account = resolveWhatsAppAccount({ cfg, accountId });
  const hasGroupAllowFrom = Boolean(account.groupAllowFrom?.length || account.allowFrom?.length);

  return resolveChannelGroupPolicy({
    cfg,
    channel: "whatsapp",
    groupId: groupId ?? conversationId,
    accountId, // 传递 accountId
    hasGroupAllowFrom,
  });
}
```

**修改2：更新 `resolveGroupRequireMentionFor` 函数签名和实现**

```typescript
export function resolveGroupRequireMentionFor(
  cfg: ReturnType<typeof loadConfig>,
  conversationId: string,
  accountId?: string, // 新增参数
) {
  const groupId = resolveGroupSessionKey({
    From: conversationId,
    ChatType: "group",
    Provider: "whatsapp",
  })?.id;
  return resolveChannelGroupRequireMention({
    cfg,
    channel: "whatsapp",
    groupId: groupId ?? conversationId,
    accountId, // 传递 accountId
  });
}
```

**修改3：更新 `resolveGroupActivationFor` 中的调用**

```typescript
export function resolveGroupActivationFor(params: {
  cfg: ReturnType<typeof loadConfig>;
  agentId: string;
  sessionKey: string;
  conversationId: string;
  accountId?: string; // 新增参数
}) {
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  const store = loadSessionStore(storePath);
  const entry = store[params.sessionKey];
  const requireMention = resolveGroupRequireMentionFor(
    params.cfg,
    params.conversationId,
    params.accountId, // 传递 accountId
  );
  const defaultActivation = !requireMention ? "always" : "mention";
  return normalizeGroupActivation(entry?.groupActivation) ?? defaultActivation;
}
```

### 3.2 修改 `group-gating.ts` - 传递 accountId

```typescript
// src/web/auto-reply/monitor/group-gating.ts
// 第22-36行：在 ApplyGroupGatingParams 类型中添加 accountId
type ApplyGroupGatingParams = {
  cfg: ReturnType<typeof loadConfig>;
  msg: WebInboundMsg;
  conversationId: string;
  groupHistoryKey: string;
  agentId: string;
  sessionKey: string;
  baseMentionConfig: MentionConfig;
  authDir?: string;
  groupHistories: Map<string, GroupHistoryEntry[]>;
  groupHistoryLimit: number;
  groupMemberNames: Map<string, Map<string, string>>;
  logVerbose: (msg: string) => void;
  replyLogger: { debug: (obj: unknown, msg: string) => void };
  accountId?: string; // 新增
};

// 第82-83行：更新 resolveGroupPolicyFor 调用
export function applyGroupGating(params: ApplyGroupGatingParams) {
  const groupPolicy = resolveGroupPolicyFor(
    params.cfg,
    params.conversationId,
    params.accountId, // 传递 accountId
  );
  // ...
}

// 第123-128行：更新 resolveGroupActivationFor 调用
const activation = resolveGroupActivationFor({
  cfg: params.cfg,
  agentId: params.agentId,
  sessionKey: params.sessionKey,
  conversationId: params.conversationId,
  accountId: params.accountId, // 传递 accountId
});
```

### 3.3 修改 `on-message.ts` - 使用最新配置

**修改1：更新 `processMessage` 调用**

```typescript
// src/web/auto-reply/monitor/on-message.ts
// 第33-61行：processForRoute 函数
const processForRoute = async (
  msg: WebInboundMsg,
  route: ReturnType<typeof resolveAgentRoute>,
  groupHistoryKey: string,
  opts?: {
    groupHistory?: GroupHistoryEntry[];
    suppressGroupHistoryClear?: boolean;
  },
) =>
  processMessage({
    cfg: loadConfig(), // 改为使用最新配置
    msg,
    route,
    // ... 其他参数保持不变
  });
```

**修改2：更新 `updateLastRouteInBackground` 调用**

```typescript
// 第115-125行
updateLastRouteInBackground({
  cfg: loadConfig(), // 改为使用最新配置
  backgroundTasks: params.backgroundTasks,
  storeAgentId: route.agentId,
  sessionKey: route.sessionKey,
  channel: "whatsapp",
  to: conversationId,
  accountId: route.accountId,
  ctx: metaCtx,
  warn: params.replyLogger.warn.bind(params.replyLogger),
});
```

**修改3：更新 `applyGroupGating` 调用**

```typescript
// 第127-141行
const gating = applyGroupGating({
  cfg: loadConfig(), // 改为使用最新配置
  msg,
  conversationId,
  groupHistoryKey,
  agentId: route.agentId,
  sessionKey: route.sessionKey,
  baseMentionConfig: params.baseMentionConfig,
  authDir: params.account.authDir,
  groupHistories: params.groupHistories,
  groupHistoryLimit: params.groupHistoryLimit,
  groupMemberNames: params.groupMemberNames,
  logVerbose,
  replyLogger: params.replyLogger,
  accountId: route.accountId, // 新增：传递 accountId
});
```

**修改4：更新 `maybeBroadcastMessage` 调用**

```typescript
// 第155-163行
if (
  await maybeBroadcastMessage({
    cfg: loadConfig(), // 改为使用最新配置
    msg,
    peerId,
    route,
    groupHistoryKey,
    groupHistories: params.groupHistories,
    processMessage: processForRoute,
  })
) {
  return;
}
```

### 3.4 修改 `broadcast.ts` - 使用最新配置（可选优化）

虽然 `broadcast.ts` 中的配置使用是读取 `broadcast` 和 `agents` 配置，但为了保持一致性，也应该考虑使用最新配置：

```typescript
// src/web/auto-reply/monitor/broadcast.ts
// 第14-30行：更新函数签名以接受 cfg 参数
export async function maybeBroadcastMessage(params: {
  cfg: ReturnType<typeof loadConfig>;
  // ...
}) {
  const broadcastAgents = params.cfg.broadcast?.[params.peerId];
  // ...
}
```

由于 `maybeBroadcastMessage` 已经在每次调用时从参数接收 `cfg`，且调用方已改为传入 `loadConfig()` 的结果，此处无需额外修改。

## 4. 预期影响和风险评估

### 4.1 预期影响

1. **配置热重载生效**：运行时修改配置（如切换 `requireMention`、更改群组策略）将立即生效，无需重启服务
2. **多账户支持完善**：非默认 WhatsApp 账户的群组策略和提及要求将正确应用
3. **账户特定覆盖生效**：`groupAllowFrom` 和 `allowFrom` 的账户特定配置将被正确识别

### 4.2 风险评估

| 风险点     | 等级 | 说明                                                                    | 缓解措施                                    |
| ---------- | ---- | ----------------------------------------------------------------------- | ------------------------------------------- |
| 性能影响   | 低   | 每次消息处理增加多次 `loadConfig()` 调用                                | `loadConfig()` 内部有缓存机制，实际开销很小 |
| 配置一致性 | 中   | 同一消息处理流程中可能使用不同版本的配置                                | 单次消息处理中配置变更概率极低，可接受      |
| 向后兼容性 | 低   | `resolveGroupPolicyFor` 和 `resolveGroupRequireMentionFor` 新增可选参数 | 参数为可选，现有调用不受影响                |
| 类型安全   | 低   | 需要确保所有调用点传递正确的 accountId                                  | TypeScript 编译器会检查类型                 |

### 4.3 测试建议

1. **单元测试**：
   - 验证 `resolveGroupPolicyFor` 正确处理账户特定配置
   - 验证 `resolveGroupRequireMentionFor` 传递 accountId

2. **集成测试**：
   - 模拟运行时配置更改，验证新配置被正确应用
   - 测试多账户场景下的群组策略解析

3. **回归测试**：
   - 验证默认账户行为不受影响
   - 验证群组激活状态持久化仍然有效

## 5. 备选方案

### 方案A：配置订阅/通知模式（推荐用于未来优化）

**思路**：实现配置变更订阅机制，当配置更改时通知所有相关组件。

```typescript
// 概念代码
interface ConfigSubscriber {
  onConfigUpdated(newConfig: Config): void;
}

class ConfigManager {
  private subscribers: Set<ConfigSubscriber> = new Set();

  subscribe(subscriber: ConfigSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  private notifySubscribers() {
    const config = this.loadConfig();
    for (const subscriber of this.subscribers) {
      subscriber.onConfigUpdated(config);
    }
  }
}
```

**优点**：

- 配置更新更可控
- 可以批量处理配置变更
- 避免频繁调用 `loadConfig()`

**缺点**：

- 实现复杂度高
- 需要重构大量现有代码
- 超出当前 Issue 范围

### 方案B：配置代理模式

**思路**：使用 Proxy 包装配置对象，在访问时动态解析最新配置。

```typescript
function createConfigProxy(): Config {
  return new Proxy(
    {},
    {
      get(target, prop) {
        const config = loadConfig();
        return (config as any)[prop];
      },
    },
  );
}
```

**优点**：

- 对调用方透明
- 无需修改现有调用点

**缺点**：

- 性能开销不可控
- 调试困难
- 类型安全难以保证

### 方案C：最小化修改方案（当前采用）

**思路**：仅在关键调用点替换为 `loadConfig()`，保持改动最小化。

**优点**：

- 实现简单
- 风险可控
- 与现有代码风格一致（参考 `resolveAgentRoute` 的做法）

**缺点**：

- 同一消息处理中可能使用不同配置版本
- 需要手动确保所有调用点都被更新

## 6. 实施检查清单

- [ ] 1. 修改 `group-activation.ts` - 添加 `accountId` 参数
- [ ] 2. 修改 `group-gating.ts` - 更新类型和调用
- [ ] 3. 修改 `on-message.ts` - 替换4处 `params.cfg` 为 `loadConfig()`
- [ ] 4. 运行 TypeScript 编译检查类型错误
- [ ] 5. 运行相关单元测试
- [ ] 6. 进行手动集成测试
- [ ] 7. 更新相关文档（如有）

## 7. 相关代码引用

### 7.1 关键文件路径

- `D:\code_self\openclaw-pr\openclaw\src\web\auto-reply\monitor\on-message.ts`
- `D:\code_self\openclaw-pr\openclaw\src\web\auto-reply\monitor\group-activation.ts`
- `D:\code_self\openclaw-pr\openclaw\src\web\auto-reply\monitor\group-gating.ts`
- `D:\code_self\openclaw-pr\openclaw\src\web\auto-reply\monitor\broadcast.ts`
- `D:\code_self\openclaw-pr\openclaw\src\config\group-policy.ts`
- `D:\code_self\openclaw-pr\openclaw\src\web\accounts.ts`

### 7.2 关键函数签名

```typescript
// src/config/group-policy.ts
export function resolveChannelGroupPolicy(params: {
  cfg: OpenClawConfig;
  channel: GroupPolicyChannel;
  groupId?: string | null;
  accountId?: string | null; // 已支持
  groupIdCaseInsensitive?: boolean;
  hasGroupAllowFrom?: boolean;
}): ChannelGroupPolicy;

export function resolveChannelGroupRequireMention(params: {
  cfg: OpenClawConfig;
  channel: GroupPolicyChannel;
  groupId?: string | null;
  accountId?: string | null; // 已支持
  // ...
}): boolean;

// src/web/accounts.ts
export function resolveWhatsAppAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedWhatsAppAccount; // 包含 groupAllowFrom 和 allowFrom
```

---

**文档版本**: 1.0
**创建日期**: 2026-03-04
**对应 Issue**: #33974
