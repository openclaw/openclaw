# 安全增强：消息发送敏感信息打码功能

## 概述

实现了在消息发送时自动检测并打码敏感信息（如 API 密钥、Token 等）的安全功能。

## 修改的文件

### 1. `src/logging/redact.ts` (增强)
**修改内容：**
- 添加了 `dynamicSensitiveValues: Set<string>` 用于存储运行时发现的敏感值
- 增强了 `redactText()` 函数，先替换动态敏感值，然后再应用正则模式
- 新增公共 API：
  - `addSensitiveValue(value: string)`: 添加单个敏感值
  - `addSensitiveValues(values: string[])`: 批量添加敏感值
  - `clearDynamicSensitiveValues()`: 清除所有动态值
  - `getDynamicSensitiveValuesCount()`: 获取动态值数量

**功能：**
- 支持正则模式匹配（已有功能）
- 新增支持精确字符串匹配（动态添加的值）
- 打码格式：保留前6位和后4位，中间用 `…` 替换

### 2. `src/logging/redact-init.ts` (新建)
**功能：**
- 扫描 `openclaw.json` 配置文件，识别敏感配置项
- 扫描环境变量，识别敏感值
- 自动提取并注册这些值到打码系统

**敏感键模式：**
```javascript
const SENSITIVE_KEY_PATTERNS = [
  /api[_-]?key/i,
  /private[_-]?key/i,
  /secret/i,
  /token/i,
  /password/i,
  /passwd/i,
  /credential/i,
  /auth/i,
];
```

**扫描范围：**
- `agents.defaults.sandbox.docker.env`
- `providers.*`
- `gateway.*`
- `plugins[*].*`
- 所有环境变量

### 3. `src/infra/outbound/outbound-send-service.ts` (修改)
**修改内容：**
- 在 `executeSendAction()` 中，发送消息前对 `message` 进行打码
- 在 `executePollAction()` 中，发送投票前对 `question` 和 `options` 进行打码

**代码示例：**
```typescript
const redactedMessage = redactSensitiveText(params.message);
// 然后使用 redactedMessage 而不是 params.message
```

### 4. `src/cli/program/preaction.ts` (修改)
**修改内容：**
- 在 `registerPreActionHooks()` 的 preAction hook 中添加初始化调用
- 在 `ensureConfigReady()` 之后调用，确保配置已加载
- 使用 try-catch 包裹，确保初始化失败不影响程序启动

**代码示例：**
```typescript
try {
  const { initializeRedactionWithConfig } = await import("../../logging/redact-init.js");
  const { loadConfig } = await import("../../config/config.js");
  const config = loadConfig();
  initializeRedactionWithConfig(config);
} catch {
  // Best-effort initialization
}
```

## 工作流程

### 启动时
1. CLI 启动 → preAction hook 执行
2. 加载配置文件（`ensureConfigReady`）
3. 调用 `initializeRedactionWithConfig(config)`
4. 扫描配置和环境变量，提取敏感值
5. 调用 `addSensitiveValues()` 注册到打码系统

### 消息发送时
1. Agent/用户调用发送消息
2. → `executeSendAction()` 或 `executePollAction()`
3. → 调用 `redactSensitiveText()` 打码
4. → 发送打码后的消息到 TG/Discord/Slack 等渠道

## 打码示例

### 示例 1: sk- 开头的密钥
```
原始: sk-3hjd98348hfkwduy83e4iuhfsa7t5623
打码: sk-3hj**************a7t5
```

### 示例 2: GitHub Token
```
原始: ghp_1234567890abcdefghij1234567890
打码: ghp_12**************7890
```

### 示例 3: 环境变量格式
```
原始: API_KEY=sk-proj-1234567890abcdefghijklmnopqrstuvwxyz12345678
打码: API_KEY=sk-pro**************5678
```

### 示例 4: 配置中的自定义值
如果 `openclaw.json` 中有：
```json
{
  "providers": {
    "openai": {
      "apiKey": "sk-custom-1234567890abcdefghij"
    }
  }
}
```

启动时会自动提取 `sk-custom-1234567890abcdefghij`，
之后任何包含这个值的消息都会被打码为 `sk-cus**************ghij`

## 支持的密钥格式

### 正则模式识别（已有）
- `sk-*` - OpenAI/Anthropic API keys
- `ghp_*` - GitHub personal access tokens
- `github_pat_*` - GitHub fine-grained tokens
- `xox*-*` - Slack tokens
- `xapp-*` - Slack app tokens
- `gsk_*` - Google Service Keys
- `AIza*` - Google API keys
- `pplx-*` - Perplexity API keys
- `npm_*` - NPM tokens
- `数字:*` - Telegram bot tokens
- PEM 私钥块
- Bearer tokens
- 环境变量赋值格式
- JSON 字段格式

### 动态值识别（新增）
- 从 `openclaw.json` 配置提取的实际密钥值
- 从环境变量提取的实际密钥值

## 安全特性

1. **最小长度限制**: 只打码长度 ≥ 18 的值，避免误报
2. **保留上下文**: 保留前6位和后4位，便于识别
3. **递归扫描**: 扫描嵌套配置对象，最大深度 10 层
4. **故障隔离**: 初始化失败不影响程序启动
5. **性能优化**: 使用 Set 存储，快速查找
6. **零配置**: 自动扫描，无需手动配置

## 测试

可以运行测试文件验证功能：
```bash
node test-redaction.js
```

## 注意事项

1. **不影响日志**: 此打码仅应用于外发消息，不影响内部日志
2. **性能影响**: 对每条消息进行正则和字符串替换，有轻微性能开销
3. **覆盖范围**: 目前仅在 `outbound-send-service.ts` 层面打码，对于直接调用各渠道发送 API 的代码可能需要额外处理
4. **启动时机**: 只在 preAction hook 执行时初始化，对于不经过 CLI 启动的场景需要手动调用

## 未来改进方向

1. 在更多发送路径添加打码（如 WebSocket 消息）
2. 支持自定义打码格式（如星号、全隐藏等）
3. 添加打码统计和日志
4. 支持配置白名单（某些密钥不打码）
5. 添加单元测试

---

**实现日期**: 2026-03-13
**分支**: security-message-redaction
