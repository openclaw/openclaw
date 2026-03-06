# Issue #33974: WhatsApp 运行时配置更改被静默忽略 - 修复方案

## 1. 问题根因分析

### 1.1 核心问题：闭包捕获陈旧配置快照

在 `src/web/auto-reply/monitor/on-message.ts` 中，`createWebOnMessageHandler` 函数在创建时捕获了 `params.cfg`，这是一个配置对象的快照。由于 JavaScript 闭包的特性，这个 `cfg` 引用在处理器生命周期内保持不变，即使底层配置文件已被修改。

```typescript
// on-message.ts 第18-32行
export function createWebOnMessageHandler(params: {
  cfg: ReturnType<typeof loadConfig>;  // 创建时传入的配置快照
  // ...
}) {
  // 第43行: processMessage 使用陈旧配置
  processMessage({ cfg: params.cfg, ... })

  // 第116行: updateLastRouteInBackground 使用陈旧配置
  updateLastRouteInBackground({ cfg: params.cfg, ... })

  // 第128行: applyGroupGating 使用陈旧配置
  applyGroupGating({ cfg: params.cfg, ... })

  // 第156行: maybeBroadcastMessage 使用陈旧配置
  maybeBroadcastMessage({ cfg: params.cfg, ... })
}
```

### 1.2 配置加载机制

`loadConfig()` 函数（`src/config/io.ts:1348`）实现了以下逻辑：

1. 首先检查 `runtimeConfigSnapshot`（运行时配置快照）
2. 然后检查文件缓存（如果启用）
3. 最后从磁盘重新加载配置

这意味着每次调用 `loadConfig()` 都能获取最新配置，而持有旧的配置引用则无法感知更改。

### 1.3 已确认的正确模式

在同一文件中，`resolveAgentRoute` 的调用（第67-68行）已经正确使用了 `loadConfig()`：

```typescript
// 第67-68行 - 正确模式
const route = resolveAgentRoute({
  cfg: loadConfig(), // 每次调用都获取最新配置
  // ...
});
```

### 1.4 附加问题：账户特定配置丢失

#### 问题 A：`resolveGroupPolicyFor` 和 `resolveGroupRequireMentionFor` 不传递 `accountId`

在 `src/web/auto-reply/monitor/group-activation.ts` 中：

```typescript
// 第13-31行
export function resolveGroupPolicyFor(cfg: ReturnType<typeof loadConfig>, conversationId: string) {
  // ...
  return resolveChannelGroupPolicy({
    cfg,
    channel: "whatsapp",
    groupId: groupId ?? conversationId,
    hasGroupAllowFrom,
    // 缺少 accountId 参数！
  });
}

// 第33-47行
export function resolveGroupRequireMentionFor(
  cfg: ReturnType<typeof loadConfig>,
  conversationId: string,
) {
  // ...
  return resolveChannelGroupRequireMention({
    cfg,
    channel: "whatsapp",
    groupId: groupId ?? conversationId,
    // 缺少 accountId 参数！
  });
}
```

对比 `resolveChannelGroupPolicy` 的定义（`src/config/group-policy.ts:325-333`）：

```typescript
export function resolveChannelGroupPolicy(params: {
  cfg: OpenClawConfig;
  channel: GroupPolicyChannel;
  groupId?: string | null;
  accountId?: string | null; // 支持账户特定配置
  // ...
}): ChannelGroupPolicy;
```

配置系统支持账户特定的群组策略（`src/config/group-policy.ts:282-299`）：

```typescript
function resolveChannelGroups(
  cfg: OpenClawConfig,
  channel: GroupPolicyChannel,
  accountId?: string | null,  // 用于查找账户特定配置
): ChannelGroups | undefined {
  const normalizedAccountId = normalizeAccountId(accountId);
  const channelConfig = cfg.channels?.[channel] as ...;
  // 优先使用账户特定配置
  const accountGroups = resolveAccountEntry(channelConfig.accounts, normalizedAccountId)?.groups;
  return accountGroups ?? channelConfig.groups;
}
```

#### 问题 B：`hasGroupAllowFrom` 只从顶层配置计算

在 `group-activation.ts` 第19-24行：

```typescript
const whatsappCfg = cfg.channels?.whatsapp as
  | { groupAllowFrom?: string[]; allowFrom?: string[] }
  | undefined;
const hasGroupAllowFrom = Boolean(
  whatsappCfg?.groupAllowFrom?.length || whatsappCfg?.allowFrom?.length,
);
```

这段代码只检查顶层 `cfg.channels.whatsapp`，忽略了账户特定的 `cfg.channels.whatsapp.accounts[accountId].groupAllowFrom` 配置。

### 1.5 影响范围

1. **运行时配置更改被忽略**：管理员修改配置后，WhatsApp 消息处理器继续使用旧配置
2. **非默认账户的群组策略失效**：使用非默认 WhatsApp 账户时，账户特定的群组策略配置被忽略
3. **群组白名单行为不一致**：`groupAllowFrom` 配置在账户级别设置时无法正确生效

---

## 2. 计划修改的文件列表

### 2.1 主文件：`src/web/auto-reply/monitor/on-message.ts`

| 行号 | 当前代码          | 需要修改                          | 原因                                         |
| ---- | ----------------- | --------------------------------- | -------------------------------------------- |
| 43   | `cfg: params.cfg` | `cfg: loadConfig()`               | 使用最新配置调用 processMessage              |
| 116  | `cfg: params.cfg` | `cfg: loadConfig()`               | 使用最新配置调用 updateLastRouteInBackground |
| 128  | `cfg: params.cfg` | `cfg: loadConfig()`               | 使用最新配置调用 applyGroupGating            |
| 156  | `cfg: params.cfg` | `cfg: loadConfig()`               | 使用最新配置调用 maybeBroadcastMessage       |
| 128  | 参数列表          | 添加 `accountId: route.accountId` | 传递账户ID以支持账户特定配置                 |

### 2.2 群组激活模块：`src/web/auto-reply/monitor/group-activation.ts`

| 行号  | 函数                            | 修改内容                                                                   |
| ----- | ------------------------------- | -------------------------------------------------------------------------- |
| 13    | `resolveGroupPolicyFor`         | 添加 `accountId?: string` 参数，传递给 `resolveChannelGroupPolicy`         |
| 33    | `resolveGroupRequireMentionFor` | 添加 `accountId?: string` 参数，传递给 `resolveChannelGroupRequireMention` |
| 19-24 | `hasGroupAllowFrom` 计算        | 使用 `resolveWhatsAppAccount` 获取账户特定配置                             |
| 49-63 | `resolveGroupActivationFor`     | 更新对 `resolveGroupRequireMentionFor` 的调用，传递 `accountId`            |

### 2.3 群组门控模块：`src/web/auto-reply/monitor/group-gating.ts`

| 行号    | 修改内容                                                      |
| ------- | ------------------------------------------------------------- |
| 22-36   | `ApplyGroupGatingParams` 类型：添加 `accountId?: string` 字段 |
| 83      | `resolveGroupPolicyFor` 调用：添加 `accountId` 参数           |
| 123-128 | `resolveGroupActivationFor` 调用：确保 `accountId` 被传递     |

---

## 3. 详细修复步骤

### 方案一：最小侵入式修改（推荐）

此方案保持现有函数签名不变，仅在必要时添加可选参数，最大程度保持向后兼容。

#### 步骤 1：修改 `group-activation.ts`

```typescript
// 添加导入
import { resolveWhatsAppAccount } from "../../accounts.js";

// 修改 resolveGroupPolicyFor 函数签名
export function resolveGroupPolicyFor(
  cfg: ReturnType<typeof loadConfig>,
  conversationId: string,
  accountId?: string, // 新增可选参数
) {
  const groupId = resolveGroupSessionKey({
    From: conversationId,
    ChatType: "group",
    Provider: "whatsapp",
  })?.id;

  // 使用 resolveWhatsAppAccount 获取账户特定配置
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

// 修改 resolveGroupRequireMentionFor 函数签名
export function resolveGroupRequireMentionFor(
  cfg: ReturnType<typeof loadConfig>,
  conversationId: string,
  accountId?: string, // 新增可选参数
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

// 修改 resolveGroupActivationFor 以传递 accountId
export function resolveGroupActivationFor(params: {
  cfg: ReturnType<typeof loadConfig>;
  agentId: string;
  sessionKey: string;
  conversationId: string;
  accountId?: string; // 新增可选参数
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

#### 步骤 2：修改 `group-gating.ts`

```typescript
// 修改 ApplyGroupGatingParams 类型
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
  accountId?: string; // 新增可选字段
};

// 修改 applyGroupGating 函数中的调用
export function applyGroupGating(params: ApplyGroupGatingParams) {
  const groupPolicy = resolveGroupPolicyFor(
    params.cfg,
    params.conversationId,
    params.accountId, // 传递 accountId
  );
  // ... 其余代码保持不变

  const activation = resolveGroupActivationFor({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    conversationId: params.conversationId,
    accountId: params.accountId, // 确保传递 accountId
  });
  // ... 其余代码保持不变
}
```

#### 步骤 3：修改 `on-message.ts`

```typescript
// 在文件顶部确保导入 loadConfig
import { loadConfig } from "../../../config/config.js";

// 修改 processForRoute 函数
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
    cfg: loadConfig(), // 改为调用 loadConfig() 获取最新配置
    msg,
    route,
    groupHistoryKey,
    groupHistories: params.groupHistories,
    groupMemberNames: params.groupMemberNames,
    connectionId: params.connectionId,
    verbose: params.verbose,
    maxMediaBytes: params.maxMediaBytes,
    replyResolver: params.replyResolver,
    replyLogger: params.replyLogger,
    backgroundTasks: params.backgroundTasks,
    rememberSentText: params.echoTracker.rememberText,
    echoHas: params.echoTracker.has,
    echoForget: params.echoTracker.forget,
    buildCombinedEchoKey: params.echoTracker.buildCombinedKey,
    groupHistory: opts?.groupHistory,
    suppressGroupHistoryClear: opts?.suppressGroupHistoryClear,
  });

// 修改返回的处理函数中的调用
return async (msg: WebInboundMsg) => {
  // ... 前面的代码保持不变

  if (msg.chatType === "group") {
    // ... metaCtx 定义保持不变

    updateLastRouteInBackground({
      cfg: loadConfig(), // 改为调用 loadConfig()
      backgroundTasks: params.backgroundTasks,
      storeAgentId: route.agentId,
      sessionKey: route.sessionKey,
      channel: "whatsapp",
      to: conversationId,
      accountId: route.accountId,
      ctx: metaCtx,
      warn: params.replyLogger.warn.bind(params.replyLogger),
    });

    const gating = applyGroupGating({
      cfg: loadConfig(), // 改为调用 loadConfig()
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
      accountId: route.accountId, // 添加 accountId
    });
    // ...
  }

  // Broadcast groups
  if (
    await maybeBroadcastMessage({
      cfg: loadConfig(), // 改为调用 loadConfig()
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

  await processForRoute(msg, route, groupHistoryKey);
};
```

### 方案二：重构优化（长期维护性更好）

此方案引入配置提供者模式，避免重复调用 `loadConfig()`，并统一配置获取逻辑。

#### 核心思想

不再在每个调用点直接调用 `loadConfig()`，而是让处理函数在每次消息处理开始时获取一次配置，然后传递给所有下游函数。

```typescript
// 修改后的处理函数结构
return async (msg: WebInboundMsg) => {
  // 每次消息处理时获取最新配置
  const cfg = loadConfig();

  const conversationId = msg.conversationId ?? msg.from;
  const peerId = resolvePeerId(msg);
  const route = resolveAgentRoute({
    cfg, // 使用刚获取的配置
    channel: "whatsapp",
    accountId: msg.accountId,
    peer: {
      kind: msg.chatType === "group" ? "group" : "direct",
      id: peerId,
    },
  });

  // ... 后续所有调用都使用同一个 cfg 引用
};
```

#### 与方案一的对比

| 方面       | 方案一：最小侵入式                           | 方案二：重构优化        |
| ---------- | -------------------------------------------- | ----------------------- |
| 代码变更量 | 较小                                         | 较大                    |
| 配置一致性 | 每个调用点独立获取，可能获取到不同版本的配置 | 单次处理内配置一致      |
| 性能       | 多次调用 loadConfig()（有缓存，影响小）      | 每消息一次 loadConfig() |
| 维护性     | 需要记住在每个调用点使用 loadConfig()        | 更清晰的配置传递模式    |
| 向后兼容   | 完全兼容                                     | 需要修改函数签名        |

---

## 4. 预期影响和风险评估

### 4.1 预期影响

#### 正面影响

1. **配置更改立即生效**：管理员修改配置后，新消息处理将立即使用最新配置
2. **多账户支持完善**：非默认 WhatsApp 账户的群组策略配置将正确生效
3. **行为一致性**：所有配置路径都遵循相同的配置解析逻辑

#### 潜在风险

1. **性能影响**：
   - `loadConfig()` 每次调用都会检查运行时快照和缓存
   - 实际影响很小，因为配置缓存机制已经优化
   - 每消息额外调用 4-5 次 `loadConfig()`，在缓存命中时只是对象引用返回

2. **配置一致性**：
   - 方案一中，同一次消息处理的不同阶段可能获取到不同版本的配置（如果配置恰好在处理过程中被修改）
   - 这通常是可以接受的行为，因为配置更改应该尽快生效
   - 如果需要严格一致性，应采用方案二

3. **类型安全**：
   - 添加可选参数保持向后兼容，不会影响现有调用方
   - TypeScript 编译时会检查类型匹配

### 4.2 测试建议

1. **单元测试**：
   - 测试 `resolveGroupPolicyFor` 和 `resolveGroupRequireMentionFor` 的账户特定配置解析
   - 测试 `hasGroupAllowFrom` 的账户特定配置检测

2. **集成测试**：
   - 模拟配置更改，验证新消息使用最新配置
   - 测试多账户场景下的群组策略隔离

3. **回归测试**：
   - 验证默认账户行为未改变
   - 验证单账户场景下的群组策略

### 4.3 回滚计划

如果出现问题，可以通过以下步骤回滚：

1. 恢复修改的文件到原始版本
2. 重新构建项目
3. 重启 WhatsApp 服务

由于修改是向后兼容的（只添加可选参数），回滚不会破坏数据或配置。

---

## 5. 备选方案

### 方案三：配置热重载订阅模式

引入配置变更订阅机制，当配置更改时通知所有相关组件。

```typescript
// 概念示例
type ConfigSubscriber = (cfg: OpenClawConfig) => void;

class ConfigManager {
  private subscribers: Set<ConfigSubscriber> = new Set();
  private currentConfig: OpenClawConfig;

  subscribe(subscriber: ConfigSubscriber): () => void {
    this.subscribers.add(subscriber);
    subscriber(this.currentConfig);
    return () => this.subscribers.delete(subscriber);
  }

  notifyConfigChange() {
    this.currentConfig = loadConfig();
    this.subscribers.forEach((sub) => sub(this.currentConfig));
  }
}
```

**优点**：

- 配置推送模式，避免轮询
- 可以精确控制配置更新的时机

**缺点**：

- 架构改动大
- 需要管理订阅生命周期
- 过度设计，当前问题不需要这么复杂的解决方案

### 方案四：配置代理模式

使用 Proxy 对象包装配置，使配置访问自动路由到最新配置。

```typescript
function createConfigProxy(): OpenClawConfig {
  return new Proxy({} as OpenClawConfig, {
    get(target, prop) {
      const currentConfig = loadConfig();
      return currentConfig[prop as keyof OpenClawConfig];
    },
  });
}
```

**优点**：

- 对调用方透明
- 不需要修改现有代码

**缺点**：

- 性能开销大（每次属性访问都调用 loadConfig()）
- 调试困难
- 类型安全难以保证

---

## 6. 实施建议

### 推荐方案：方案一（最小侵入式修改）

理由：

1. **风险可控**：变更范围小，易于审查和测试
2. **快速交付**：可以迅速解决问题，减少配置更改被忽略的影响
3. **向后兼容**：不影响现有功能
4. **未来可扩展**：为后续重构奠定基础

### 实施步骤

1. **阶段一**：修复 `on-message.ts` 中的配置加载问题（核心问题）
2. **阶段二**：修复 `group-activation.ts` 和 `group-gating.ts` 中的账户特定配置问题
3. **阶段三**：添加单元测试覆盖新场景
4. **阶段四**：代码审查和集成测试

### 代码审查清单

- [ ] 所有 `params.cfg` 调用点都已审查
- [ ] 新增的 `accountId` 参数已正确传递
- [ ] `hasGroupAllowFrom` 使用账户特定配置
- [ ] TypeScript 编译无错误
- [ ] 单元测试通过
- [ ] 集成测试验证配置更改生效
