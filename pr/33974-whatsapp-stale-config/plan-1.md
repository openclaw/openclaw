# Issue #33974 修复方案: WhatsApp 运行时配置更改被静默忽略

## 1. 问题根因分析

### 1.1 核心问题：闭包捕获陈旧配置快照

`createWebOnMessageHandler` 函数在初始化时通过 `params.cfg` 接收配置对象，该配置是在处理器创建时刻的快照。当 `loadConfig()` 被重新调用（如配置文件被外部修改并热重载），处理器内部的 `params.cfg` 仍然指向旧的配置对象，导致所有下游调用使用陈旧的配置。

**问题代码位置**: `src/web/auto-reply/monitor/on-message.ts`

```typescript
// 第18-32行: createWebOnMessageHandler 接收 params.cfg
export function createWebOnMessageHandler(params: {
  cfg: ReturnType<typeof loadConfig>;  // 创建时传入的配置快照
  // ...
}) {
  // 第43行: 使用陈旧配置
  processMessage({ cfg: params.cfg, ... })

  // 第116行: 使用陈旧配置
  updateLastRouteInBackground({ cfg: params.cfg, ... })

  // 第128行: 使用陈旧配置
  applyGroupGating({ cfg: params.cfg, ... })

  // 第156行: 使用陈旧配置
  maybeBroadcastMessage({ cfg: params.cfg, ... })
}
```

### 1.2 已确认的正确模式

`resolveAgentRoute` 调用（第67-68行）已经正确地在每次消息处理时调用 `loadConfig()` 获取最新配置：

```typescript
// 第67-68行: 正确模式 - 每次获取最新配置
const route = resolveAgentRoute({
  cfg: loadConfig(), // 每次调用都获取最新配置
  channel: "whatsapp",
  accountId: msg.accountId,
  // ...
});
```

### 1.3 附加问题：accountId 传递缺失

**问题 1**: `resolveGroupPolicyFor` 和 `resolveGroupRequireMentionFor` 函数不接收 `accountId` 参数，导致非默认 WhatsApp 账户丢失账户特定的群组策略。

**问题 2**: `hasGroupAllowFrom` 只从顶层 `cfg.channels.whatsapp` 计算，忽略了账户特定的覆盖配置。

**影响**: 多账户部署中，非默认账户的群组策略（如 `requireMention`、群组白名单）无法正确应用。

---

## 2. 计划修改的文件列表

### 2.1 主文件：`src/web/auto-reply/monitor/on-message.ts`

| 行号 | 当前代码          | 需要修改            | 影响函数                      |
| ---- | ----------------- | ------------------- | ----------------------------- |
| 43   | `cfg: params.cfg` | `cfg: loadConfig()` | `processMessage`              |
| 116  | `cfg: params.cfg` | `cfg: loadConfig()` | `updateLastRouteInBackground` |
| 128  | `cfg: params.cfg` | `cfg: loadConfig()` | `applyGroupGating`            |
| 156  | `cfg: params.cfg` | `cfg: loadConfig()` | `maybeBroadcastMessage`       |

### 2.2 群组策略文件：`src/web/auto-reply/monitor/group-activation.ts`

| 行号  | 函数                                     | 修改内容                       |
| ----- | ---------------------------------------- | ------------------------------ |
| 13    | `resolveGroupPolicyFor`                  | 添加 `accountId?: string` 参数 |
| 33    | `resolveGroupRequireMentionFor`          | 添加 `accountId?: string` 参数 |
| 19-23 | `hasGroupAllowFrom` 计算                 | 改为使用账户特定的配置         |
| 25-30 | `resolveChannelGroupPolicy` 调用         | 传递 `accountId` 参数          |
| 42-46 | `resolveChannelGroupRequireMention` 调用 | 传递 `accountId` 参数          |

### 2.3 群组门控文件：`src/web/auto-reply/monitor/group-gating.ts`

| 行号 | 修改内容                                                     |
| ---- | ------------------------------------------------------------ |
| 83   | 更新 `resolveGroupPolicyFor` 调用，传递 `accountId`          |
| 123  | 更新 `resolveGroupActivationFor` 调用，确保 `accountId` 传递 |

---

## 3. 详细修复步骤

### 3.1 修改 `src/web/auto-reply/monitor/on-message.ts`

**步骤 1**: 在文件顶部确保 `loadConfig` 被正确导入（已存在，无需修改）

**步骤 2**: 修改 `processForRoute` 函数中的 `processMessage` 调用（第43行）

```typescript
// 修改前 (第42-61行)
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
    cfg: params.cfg, // 陈旧配置
    msg,
    route,
    // ...
  });

// 修改后
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
    cfg: loadConfig(), // 最新配置
    msg,
    route,
    // ...
  });
```

**步骤 3**: 修改 `updateLastRouteInBackground` 调用（第115-125行）

```typescript
// 修改前 (第115-125行)
updateLastRouteInBackground({
  cfg: params.cfg, // 陈旧配置
  backgroundTasks: params.backgroundTasks,
  storeAgentId: route.agentId,
  sessionKey: route.sessionKey,
  channel: "whatsapp",
  to: conversationId,
  accountId: route.accountId,
  ctx: metaCtx,
  warn: params.replyLogger.warn.bind(params.replyLogger),
});

// 修改后
updateLastRouteInBackground({
  cfg: loadConfig(), // 最新配置
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

**步骤 4**: 修改 `applyGroupGating` 调用（第127-141行）

```typescript
// 修改前 (第127-141行)
const gating = applyGroupGating({
  cfg: params.cfg, // 陈旧配置
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
});

// 修改后
const gating = applyGroupGating({
  cfg: loadConfig(), // 最新配置
  msg,
  conversationId,
  groupHistoryKey,
  agentId: route.agentId,
  sessionKey: route.sessionKey,
  accountId: route.accountId, // 新增：传递 accountId
  baseMentionConfig: params.baseMentionConfig,
  authDir: params.account.authDir,
  groupHistories: params.groupHistories,
  groupHistoryLimit: params.groupHistoryLimit,
  groupMemberNames: params.groupMemberNames,
  logVerbose,
  replyLogger: params.replyLogger,
});
```

**步骤 5**: 修改 `maybeBroadcastMessage` 调用（第154-166行）

```typescript
// 修改前 (第154-166行)
if (
  await maybeBroadcastMessage({
    cfg: params.cfg, // 陈旧配置
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

// 修改后
if (
  await maybeBroadcastMessage({
    cfg: loadConfig(), // 最新配置
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

### 3.2 修改 `src/web/auto-reply/monitor/group-activation.ts`

**步骤 1**: 修改 `resolveGroupPolicyFor` 函数签名和实现（第13-31行）

```typescript
// 修改前 (第13-31行)
export function resolveGroupPolicyFor(cfg: ReturnType<typeof loadConfig>, conversationId: string) {
  const groupId = resolveGroupSessionKey({
    From: conversationId,
    ChatType: "group",
    Provider: "whatsapp",
  })?.id;
  const whatsappCfg = cfg.channels?.whatsapp as
    | { groupAllowFrom?: string[]; allowFrom?: string[] }
    | undefined;
  const hasGroupAllowFrom = Boolean(
    whatsappCfg?.groupAllowFrom?.length || whatsappCfg?.allowFrom?.length,
  );
  return resolveChannelGroupPolicy({
    cfg,
    channel: "whatsapp",
    groupId: groupId ?? conversationId,
    hasGroupAllowFrom,
  });
}

// 修改后
export function resolveGroupPolicyFor(
  cfg: ReturnType<typeof loadConfig>,
  conversationId: string,
  accountId?: string,
) {
  const groupId = resolveGroupSessionKey({
    From: conversationId,
    ChatType: "group",
    Provider: "whatsapp",
  })?.id;

  // 获取账户特定的配置
  const channelConfig = cfg.channels?.whatsapp as
    | {
        groupAllowFrom?: string[];
        allowFrom?: string[];
        accounts?: Record<string, { groupAllowFrom?: string[]; allowFrom?: string[] }>;
      }
    | undefined;

  // 优先使用账户特定的配置
  const accountConfig = accountId ? channelConfig?.accounts?.[accountId] : undefined;
  const effectiveConfig = accountConfig ?? channelConfig;

  const hasGroupAllowFrom = Boolean(
    effectiveConfig?.groupAllowFrom?.length || effectiveConfig?.allowFrom?.length,
  );

  return resolveChannelGroupPolicy({
    cfg,
    channel: "whatsapp",
    groupId: groupId ?? conversationId,
    accountId,
    hasGroupAllowFrom,
  });
}
```

**步骤 2**: 修改 `resolveGroupRequireMentionFor` 函数签名和实现（第33-47行）

```typescript
// 修改前 (第33-47行)
export function resolveGroupRequireMentionFor(
  cfg: ReturnType<typeof loadConfig>,
  conversationId: string,
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
  });
}

// 修改后
export function resolveGroupRequireMentionFor(
  cfg: ReturnType<typeof loadConfig>,
  conversationId: string,
  accountId?: string,
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
    accountId,
  });
}
```

**步骤 3**: 修改 `resolveGroupActivationFor` 函数（第49-63行）

```typescript
// 修改前 (第49-63行)
export function resolveGroupActivationFor(params: {
  cfg: ReturnType<typeof loadConfig>;
  agentId: string;
  sessionKey: string;
  conversationId: string;
}) {
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  const store = loadSessionStore(storePath);
  const entry = store[params.sessionKey];
  const requireMention = resolveGroupRequireMentionFor(params.cfg, params.conversationId);
  const defaultActivation = !requireMention ? "always" : "mention";
  return normalizeGroupActivation(entry?.groupActivation) ?? defaultActivation;
}

// 修改后
export function resolveGroupActivationFor(params: {
  cfg: ReturnType<typeof loadConfig>;
  agentId: string;
  sessionKey: string;
  conversationId: string;
  accountId?: string;
}) {
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  const store = loadSessionStore(storePath);
  const entry = store[params.sessionKey];
  const requireMention = resolveGroupRequireMentionFor(
    params.cfg,
    params.conversationId,
    params.accountId,
  );
  const defaultActivation = !requireMention ? "always" : "mention";
  return normalizeGroupActivation(entry?.groupActivation) ?? defaultActivation;
}
```

### 3.3 修改 `src/web/auto-reply/monitor/group-gating.ts`

**步骤 1**: 修改 `ApplyGroupGatingParams` 类型，添加 `accountId`（第22-36行）

```typescript
// 修改前 (第22-36行)
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
};

// 修改后
type ApplyGroupGatingParams = {
  cfg: ReturnType<typeof loadConfig>;
  msg: WebInboundMsg;
  conversationId: string;
  groupHistoryKey: string;
  agentId: string;
  sessionKey: string;
  accountId?: string; // 新增
  baseMentionConfig: MentionConfig;
  authDir?: string;
  groupHistories: Map<string, GroupHistoryEntry[]>;
  groupHistoryLimit: number;
  groupMemberNames: Map<string, Map<string, string>>;
  logVerbose: (msg: string) => void;
  replyLogger: { debug: (obj: unknown, msg: string) => void };
};
```

**步骤 2**: 修改 `applyGroupGating` 函数中的 `resolveGroupPolicyFor` 调用（第83行）

```typescript
// 修改前 (第83行)
const groupPolicy = resolveGroupPolicyFor(params.cfg, params.conversationId);

// 修改后
const groupPolicy = resolveGroupPolicyFor(params.cfg, params.conversationId, params.accountId);
```

**步骤 3**: 修改 `applyGroupGating` 函数中的 `resolveGroupActivationFor` 调用（第123-128行）

```typescript
// 修改前 (第123-128行)
const activation = resolveGroupActivationFor({
  cfg: params.cfg,
  agentId: params.agentId,
  sessionKey: params.sessionKey,
  conversationId: params.conversationId,
});

// 修改后
const activation = resolveGroupActivationFor({
  cfg: params.cfg,
  agentId: params.agentId,
  sessionKey: params.sessionKey,
  conversationId: params.conversationId,
  accountId: params.accountId,
});
```

---

## 4. 预期影响和风险评估

### 4.1 预期正面影响

1. **配置热重载生效**: 运行时修改 `requireMention`、群组策略等配置将立即生效，无需重启服务。

2. **多账户策略正确性**: 非默认 WhatsApp 账户的群组策略（白名单、提及要求等）将正确应用。

3. **一致性**: 所有配置读取点行为一致，都使用 `loadConfig()` 获取最新配置。

### 4.2 潜在风险

| 风险                               | 可能性 | 缓解措施                                                             |
| ---------------------------------- | ------ | -------------------------------------------------------------------- |
| `loadConfig()` 调用开销            | 低     | `loadConfig()` 通常使用缓存，多次调用开销可忽略                      |
| 配置在消息处理过程中变更导致不一致 | 低     | 单条消息处理时间很短，配置变更概率极低；即使发生，也不比当前行为更差 |
| TypeScript 类型错误                | 中     | 所有修改都经过类型检查，需要确保 `accountId` 参数类型兼容            |
| 破坏向后兼容性                     | 低     | 新增的 `accountId` 参数是可选的，不影响现有调用                      |

### 4.3 测试建议

1. **单元测试**: 验证 `resolveGroupPolicyFor` 和 `resolveGroupRequireMentionFor` 在传入 `accountId` 时正确解析账户特定配置。

2. **集成测试**:
   - 启动服务后修改配置文件，验证新配置在后续消息中生效。
   - 配置多账户，验证每个账户的群组策略独立应用。

3. **回归测试**: 验证单账户场景（不传 `accountId`）行为不变。

---

## 5. 备选方案

### 方案 B: 配置订阅/通知模式

**描述**: 实现配置变更订阅机制，当 `loadConfig()` 检测到配置变更时，通知所有处理器更新其持有的配置引用。

**优点**:

- 避免每次消息处理都调用 `loadConfig()`
- 配置变更更可控

**缺点**:

- 实现复杂度高，需要引入事件系统
- 需要修改配置加载基础设施
- 当前问题不需要如此复杂的解决方案

**适用性**: 不推荐用于此问题，当前方案已足够。

### 方案 C: 将配置加载上移到调用链顶部

**描述**: 在消息处理器入口统一调用 `loadConfig()`，然后将配置对象传递给所有下游函数。

**优点**:

- 单次配置加载，避免多次调用
- 单条消息处理过程中配置保持一致

**缺点**:

- 需要修改大量函数签名
- 与当前架构（`resolveAgentRoute` 已使用 `loadConfig()`）不一致

**适用性**: 部分采用，已在 `on-message.ts` 的返回函数中统一调用 `loadConfig()`。

---

## 6. 实施检查清单

- [ ] 修改 `src/web/auto-reply/monitor/on-message.ts` 中的4个配置引用点
- [ ] 修改 `src/web/auto-reply/monitor/group-activation.ts` 中的3个函数
- [ ] 修改 `src/web/auto-reply/monitor/group-gating.ts` 中的类型定义和2个调用点
- [ ] 运行 TypeScript 类型检查: `tsc --noEmit`
- [ ] 运行相关单元测试
- [ ] 验证多账户群组策略场景
- [ ] 验证配置热重载场景

---

## 7. 相关代码引用

### 文件路径汇总

| 文件                  | 绝对路径                                                                           |
| --------------------- | ---------------------------------------------------------------------------------- |
| `on-message.ts`       | `D:\code_self\openclaw-pr\openclaw\src\web\auto-reply\monitor\on-message.ts`       |
| `group-activation.ts` | `D:\code_self\openclaw-pr\openclaw\src\web\auto-reply\monitor\group-activation.ts` |
| `group-gating.ts`     | `D:\code_self\openclaw-pr\openclaw\src\web\auto-reply\monitor\group-gating.ts`     |
| `group-policy.ts`     | `D:\code_self\openclaw-pr\openclaw\src\config\group-policy.ts`                     |

### 关键函数签名参考

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
  groupIdCaseInsensitive?: boolean;
  requireMentionOverride?: boolean;
  overrideOrder?: "before-config" | "after-config";
}): boolean;
```

---

## 8. 结论

本修复方案通过以下方式解决 Issue #33974:

1. **核心修复**: 将 `on-message.ts` 中的4个配置引用点从 `params.cfg`（陈旧快照）改为 `loadConfig()`（最新配置）。

2. **附加修复**: 为群组策略相关函数添加 `accountId` 参数，确保多账户场景下账户特定的策略正确应用。

3. **类型安全**: 所有修改都保持 TypeScript 类型安全，新增参数均为可选，不影响现有调用。

该方案实现简单、风险低、与现有代码风格一致，是解决此问题的最佳方案。
