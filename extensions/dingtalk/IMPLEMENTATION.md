# DingTalk Extension Implementation Guide

## 已完成的工作

### 1. 基础结构
- ✅ Extension 基础文件结构已创建
  - `package.json` - 插件配置和依赖
  - `openclaw.plugin.json` - 插件元数据
  - `index.ts` - 插件入口和注册
  - `src/runtime.ts` - 运行时管理

### 2. 配置系统集成
- ✅ 核心类型定义 (`src/config/types.dingtalk.ts`)
  - `DingTalkConfig` - 主配置类型
  - `DingTalkChannelConfig` - 频道级配置
  - `DingTalkGroupConfig` - 群组级配置
- ✅ Schema 验证 (`src/config/zod-schema.providers-core.ts`)
  - `DingTalkConfigSchema` - Zod schema 定义
  - `DingTalkChannelSchema` - 频道 schema
  - `DingTalkGroupSchema` - 群组 schema
- ✅ 主配置集成
  - `src/config/types.channels.ts` - 添加 `dingtalk?: DingTalkConfig`
  - `src/config/zod-schema.providers.ts` - 添加 `dingtalk: DingTalkConfigSchema`

### 3. Channel Plugin 实现
- ✅ `src/channel.ts` - 完整的 channel plugin 定义
  - 配置适配器 (config adapter)
  - 配对流程 (pairing)
  - 消息路由 (messaging)
  - 目录服务 (directory)
  - 状态管理 (status)
  - Gateway 集成 (gateway)
- ✅ `src/outbound.ts` - 消息发送适配器
- ✅ `src/token.ts` - 凭证解析
- ✅ `src/probe.ts` - 连接探测（占位实现）
- ✅ `src/send.ts` - 消息发送（占位实现）
- ✅ `src/monitor.ts` - Stream 模式监控（占位实现）
- ✅ `src/errors.ts` - 错误处理工具

### 4. 文档和配置
- ✅ `docs/channels/dingtalk.md` - 完整的使用文档
- ✅ `.github/labeler.yml` - 添加 DingTalk 标签规则

## 待完成的工作

### 1. DingTalk Stream SDK 集成

#### 1.1 安装依赖
首先需要确认 `dingtalk-stream` SDK 的正确包名和版本：
```bash
cd extensions/dingtalk
pnpm add dingtalk-stream
```

如果官方 SDK 不存在或名称不同，可能需要：
- 查找正确的 npm 包名
- 或者直接使用 WebSocket 实现（参考 `extensions/voice-call` 的实现）

#### 1.2 实现 `monitor.ts`
需要完成 `monitorDingTalkProvider` 函数：

```typescript
// src/monitor.ts
import { Client } from 'dingtalk-stream'; // 假设的 SDK 导入

export async function monitorDingTalkProvider(
  opts: MonitorDingTalkOpts,
): Promise<MonitorDingTalkResult> {
  // 1. 初始化 DingTalk Stream Client
  const client = new Client({
    appKey: creds.appKey,
    appSecret: creds.appSecret,
  });

  // 2. 注册消息处理器
  client.on('message', async (event) => {
    // 处理接收到的消息
    // - 解析消息内容
    // - 检查 allowlist/policy
    // - 检查 @mention 要求
    // - 路由到 OpenClaw 的消息系统
  });

  // 3. 注册事件处理器（如果需要）
  client.on('event', async (event) => {
    // 处理其他事件（如用户加入群组等）
  });

  // 4. 启动连接
  await client.start();

  return {
    shutdown: async () => {
      await client.stop();
    },
  };
}
```

关键点：
- 使用 WebSocket 连接（stream mode）
- 处理消息接收和路由
- 实现 allowlist/policy 检查
- 实现 @mention 检测
- 处理重连逻辑

#### 1.3 实现 `send.ts`
完成 `sendMessageDingTalk` 函数：

```typescript
// src/send.ts
export async function sendMessageDingTalk(
  params: SendDingTalkMessageParams,
): Promise<SendDingTalkMessageResult> {
  // 1. 获取 DingTalk Stream Client 实例
  // 2. 构建消息内容
  // 3. 发送消息到指定用户/群组
  // 4. 返回消息 ID 和会话 ID
}
```

需要支持：
- 文本消息
- Markdown 格式化
- 媒体附件（图片、文件）
- 消息分块（如果超过限制）

#### 1.4 完善 `probe.ts`
实现实际的凭证验证：

```typescript
// src/probe.ts
export async function probeDingTalk(cfg?: DingTalkConfig): Promise<ProbeDingTalkResult> {
  // 1. 验证凭证格式
  // 2. 尝试连接 DingTalk Stream API
  // 3. 验证 AppKey/AppSecret 是否有效
  // 4. 返回验证结果
}
```

### 2. 消息处理逻辑

#### 2.1 消息路由
在 `monitor.ts` 中实现消息路由到 OpenClaw 的核心系统：

```typescript
// 需要调用 OpenClaw 的消息路由 API
// 参考其他 channel 的实现方式
import { routeInboundMessage } from 'openclaw/plugin-sdk';

await routeInboundMessage({
  channel: 'dingtalk',
  from: event.senderId,
  to: event.conversationId,
  text: event.text,
  // ... 其他字段
});
```

#### 2.2 Allowlist/Policy 检查
实现群组和 DM 的访问控制：

```typescript
// 检查 DM 策略
if (isDM) {
  if (dmPolicy === 'pairing') {
    // 检查是否已配对
    // 如果未配对，发送配对请求
  } else if (dmPolicy === 'open') {
    // 检查 allowFrom
  }
}

// 检查群组策略
if (isGroup) {
  if (groupPolicy === 'allowlist') {
    // 检查 sender 是否在 allowlist 中
  } else if (groupPolicy === 'open') {
    // 检查 @mention 要求
  }
}
```

#### 2.3 @Mention 检测
实现 @mention 检测逻辑：

```typescript
// 检查消息中是否包含 @bot
const botUserId = getBotUserId();
const mentioned = message.text.includes(`@${botUserId}`) || 
                  message.mentions?.includes(botUserId);

if (requireMention && !mentioned) {
  // 忽略消息
  return;
}
```

### 3. 配对流程

实现 DM 配对流程：

```typescript
// 在 monitor.ts 中
if (isDM && dmPolicy === 'pairing') {
  const isPaired = await checkPairingStatus(senderId);
  if (!isPaired) {
    // 创建配对请求
    await createPairingRequest({
      channel: 'dingtalk',
      userId: senderId,
    });
    // 发送配对提示消息
    await sendPairingMessage(senderId);
    return; // 不处理消息
  }
}
```

### 4. 媒体处理

实现媒体附件处理：

```typescript
// 接收媒体
if (event.mediaUrl) {
  // 下载媒体文件
  const mediaBuffer = await downloadMedia(event.mediaUrl);
  // 保存到本地或上传到存储
  // 传递给消息路由系统
}

// 发送媒体
if (mediaUrl) {
  // 上传媒体到 DingTalk
  // 获取媒体 URL
  // 在消息中包含媒体
}
```

### 5. 错误处理和重连

实现健壮的错误处理和自动重连：

```typescript
// 在 monitor.ts 中
client.on('error', (error) => {
  log.error('DingTalk stream error:', error);
  // 记录错误
  // 触发重连逻辑
});

client.on('close', () => {
  log.warn('DingTalk stream closed');
  // 实现指数退避重连
  scheduleReconnect();
});
```

## 测试计划

### 1. 单元测试
- [ ] `token.ts` - 凭证解析测试
- [ ] `probe.ts` - 连接探测测试
- [ ] `send.ts` - 消息发送测试
- [ ] `channel.ts` - Channel plugin 配置测试

### 2. 集成测试
- [ ] Stream 连接测试
- [ ] 消息接收和路由测试
- [ ] 消息发送测试
- [ ] Allowlist/Policy 测试
- [ ] @Mention 检测测试
- [ ] 配对流程测试

### 3. E2E 测试
- [ ] DM 消息收发
- [ ] 群组消息收发
- [ ] 媒体附件处理
- [ ] 错误恢复和重连

## 参考资源

1. **DingTalk Stream SDK**
   - GitHub: https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs
   - 文档: https://open.dingtalk.com/document/

2. **类似实现参考**
   - `extensions/msteams` - Bot Framework 实现
   - `extensions/voice-call` - WebSocket 实现示例
   - `extensions/matrix` - 另一个 messaging channel 实现

3. **OpenClaw Plugin SDK**
   - 查看 `openclaw/plugin-sdk` 中的类型定义
   - 参考其他 channel 的实现模式

## 后续步骤

1. **研究 DingTalk Stream SDK**
   - 确认正确的 npm 包名和版本
   - 阅读 SDK 文档和示例
   - 理解消息格式和事件类型

2. **实现核心功能**
   - 先实现 `monitor.ts` 的基础连接
   - 实现消息接收和路由
   - 实现 `send.ts` 的消息发送

3. **完善功能**
   - 添加 allowlist/policy 检查
   - 实现 @mention 检测
   - 实现配对流程
   - 添加媒体支持

4. **测试和优化**
   - 编写单元测试
   - 进行集成测试
   - 优化错误处理和重连逻辑

5. **文档更新**
   - 更新使用文档
   - 添加示例配置
   - 添加故障排查指南

## 注意事项

1. **Stream Mode vs Webhook Mode**
   - 当前实现使用 Stream Mode（WebSocket）
   - 不需要公共 URL 或 webhook endpoint
   - 连接是持久的，需要处理重连

2. **凭证安全**
   - AppKey 和 AppSecret 应该存储在配置文件中
   - 支持环境变量覆盖
   - 不要在日志中输出敏感信息

3. **消息格式**
   - 了解 DingTalk 的消息格式
   - 支持 Markdown（如果 DingTalk 支持）
   - 处理特殊字符和编码

4. **速率限制**
   - 了解 DingTalk API 的速率限制
   - 实现适当的重试和退避策略

5. **多账户支持**
   - 当前实现使用单账户模式（`DEFAULT_ACCOUNT_ID`）
   - 如果需要多账户，参考 `extensions/slack` 的实现
