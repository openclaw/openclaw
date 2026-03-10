# 跨渠道记忆共享 (Cross-Channel Memory)

## 概述

跨渠道记忆共享功能允许用户在不同渠道（如 DingTalk、WeChat、Webchat 等）之间共享同一个 Agent 的记忆和上下文。

## 问题背景

在默认架构中，每个渠道的会话是独立的：
- 在 Webchat 中告诉 Agent 的信息，在 DingTalk 中无法访问
- 在不同渠道切换时，上下文会断裂
- 用户感觉像是在和"不同的 Agent"对话

## 解决方案

通过启用 `crossChannelMemory` 选项，同一个 Agent 在不同渠道的 **direct chat** 将共享：
- MEMORY.md（长期记忆）
- 会话历史
- 配置文件（如股票列表、提醒等）

**注意**: Group/Channel 类型的聊天仍保持独立，因为群聊上下文本来就是独立的。

## 使用方法

### 方法 1: 使用 `--share-memory` 选项（推荐）

```bash
# 绑定多个渠道并启用跨渠道记忆共享
openclaw agents bind \
  --agent main \
  --bind webchat \
  --bind dingtalk \
  --bind wechat \
  --share-memory
```

### 方法 2: 手动配置

在配置文件中为 Agent 添加 `crossChannelMemory: true`：

```yaml
agents:
  list:
    - id: main
      crossChannelMemory: true
```

然后绑定渠道：

```bash
openclaw agents bind --agent main --bind webchat --bind dingtalk
```

## 工作原理

### SessionKey 生成

- **默认模式**: `agent:main:webchat:direct:user123`
- **跨渠道模式**: `agent:main:shared:direct:user123`

通过统一使用 `shared` 作为 channel 标识，不同渠道的 direct chat 会映射到同一个 sessionKey，从而共享记忆。

### 路由逻辑

```typescript
if (crossChannelMemory && isDirectChat) {
  // 使用统一的 channel 标识
  channel = "shared";
}
```

## 使用场景

### ✅ 适合启用跨渠道记忆

- 个人助理场景（用户在多个渠道与同一个 Agent 交互）
- 需要连续上下文的对话
- 配置/偏好需要在渠道间同步

### ❌ 不适合启用跨渠道记忆

- 每个渠道需要独立的上下文（如客服场景）
- 渠道间用户群体完全不同
- 需要渠道特定的行为/配置

## 配置示例

### 示例 1: 个人助理（启用跨渠道共享）

```yaml
agents:
  list:
    - id: main
      name: 个人助理
      crossChannelMemory: true
      bindings:
        - type: route
          agentId: main
          match:
            channel: webchat
        - type: route
          agentId: main
          match:
            channel: dingtalk
        - type: route
          agentId: main
          match:
            channel: wechat
```

### 示例 2: 多客服系统（保持渠道隔离）

```yaml
agents:
  list:
    - id: webchat-support
      name: Webchat 客服
      crossChannelMemory: false
      
    - id: dingtalk-support
      name: DingTalk 客服
      crossChannelMemory: false
```

## 注意事项

1. **隐私考虑**: 启用跨渠道记忆后，所有渠道的用户都能看到相同的记忆。确保这符合你的隐私要求。

2. **并发写入**: 多个渠道同时写入 MEMORY.md 时，使用文件锁机制避免冲突。

3. **性能影响**: 跨渠道记忆共享对性能影响极小，因为只是 sessionKey 生成逻辑的变化。

4. **向后兼容**: 此功能默认关闭，不影响现有部署。

## 技术实现

### 修改的文件

1. `src/config/types.agents.ts` - 添加 `crossChannelMemory` 配置项
2. `src/routing/resolve-route.ts` - 修改 sessionKey 生成逻辑
3. `src/commands/agents.commands.bind.ts` - 添加 `--share-memory` 选项
4. `src/cli/program/register.agent.ts` - 注册 CLI 选项

### 关键代码

```typescript
// resolve-route.ts
export function buildAgentSessionKey(params: {
  // ...
  crossChannelMemory?: boolean;
}): string {
  if (params.crossChannelMemory && isDirectChat) {
    return buildAgentPeerSessionKey({
      // ...
      channel: "shared", // 统一标识
    });
  }
  // 默认行为
}
```

## 测试

```bash
# 1. 绑定渠道并启用跨渠道记忆
openclaw agents bind --agent main --bind webchat --bind dingtalk --share-memory

# 2. 验证配置
openclaw agents list --json | jq '.[] | select(.id == "main") | .crossChannelMemory'
# 输出: true

# 3. 验证路由
openclaw agents bindings --agent main
# 应该显示所有绑定的渠道
```

## 相关链接

- [路由绑定文档](./routing-bindings.md)
- [Agent 配置文档](./agent-config.md)
- [会话管理文档](./session-management.md)
