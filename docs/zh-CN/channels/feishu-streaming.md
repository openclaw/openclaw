# 飞书流式输出配置指南

## 启用流式输出

在 OpenClaw 配置文件中添加以下配置：

### 全局配置（所有账号）

```yaml
channels:
  feishu:
    enabled: true
    appId: "cli_xxx"
    appSecret: "xxx"
    
    # 流式输出配置
    streaming:
      enabled: true          # 启用流式输出
      throttleMs: 150        # 节流间隔（毫秒），默认 150，范围 100-5000
      title: "🤖 AI 助手"    # 卡片标题栏显示的文字
```

### 多账号配置

```yaml
channels:
  feishu:
    enabled: true
    accounts:
      work:
        appId: "cli_xxx"
        appSecret: "xxx"
        streaming:
          enabled: true
          throttleMs: 150
      personal:
        appId: "cli_yyy"
        appSecret: "yyy"
        streaming:
          enabled: false  # 此账号不启用流式
```

### 简化配置（布尔值）

```yaml
channels:
  feishu:
    streaming: true  # 使用默认配置启用
```

## 工作原理

### 传统方式（有编辑次数限制）

```
用户消息 → 发送文本消息 → 编辑消息 (20-30 次上限) → 达到上限后失败
```

### 流式方式（无限制）

```
用户消息 → 创建卡片实体 → 发送卡片消息 → 更新卡片 (无次数限制) → 完成
                ↓
           返回 card_id
                ↓
         每次更新 +1 sequence
```

## 技术细节

### CardKit API

- **创建卡片**: `POST /open-apis/cardkit/v1/cards`
- **更新卡片**: `PUT /open-apis/cardkit/v1/cards/{card_id}`
- **Schema**: 2.0（支持 Markdown 渲染）

### Sequence 管理

每次更新卡片时，`sequence` 必须严格递增：
- 第一次更新：sequence = 1
- 第二次更新：sequence = 2
- ...

如果 sequence 不递增，更新会失败。

### 节流机制

为了避免触发飞书 API 频率限制：
- 默认每 150ms 最多更新一次
- 可配置范围：100ms - 5000ms
- 最后一次更新强制执行（兜底）

## 效果对比

### 未启用流式
```
[普通消息]
一次性显示完整内容
无打字机效果
```

### 启用流式
```
┌────────────────────────────┐
│ 🤖 AI 助手                 │
├────────────────────────────┤
│ 这是一段测试文本...        │  ← 逐字显示
│ 内容会逐步出现...          │
│ 像 ChatGPT 一样...         │
└────────────────────────────┘
```

## 适用场景

### ✅ 推荐使用
- AI Agent 长文本输出
- 代码生成（带代码块）
- 分析报告（500+ 字）
- 需要打字机效果的场景

### ❌ 不推荐
- 短消息（<100 字）
- 简单问答
- 不需要视觉效果的场景

## 性能影响

| 指标 | 普通模式 | 流式模式 |
|------|---------|---------|
| 首字延迟 | ~200ms | ~500ms（创建卡片） |
| API 调用次数 | 1 次 | N 次（随内容长度） |
| 编辑次数限制 | 20-30 次 | 无限制 |
| 适用内容长度 | <500 字 | 任意长度 |

## 故障排查

### 卡片创建失败
- 检查 App 权限：需要 `cardkit:card` 权限
- 检查网络：确保能访问飞书 API
- 查看日志：`openclaw logs --follow`

### 更新失败（sequence 错误）
- 检查是否有多个实例同时更新同一卡片
- 确认节流间隔设置合理
- 查看日志中的 sequence 值

### 内容不更新
- 检查 sequence 是否递增
- 确认卡片未被删除
- 检查飞书 API 返回的错误码

### 流式未启动（常见问题）
- 确认 `streaming.enabled` 为 `true`
- 确认 `renderMode` 不是 `"raw"`（`"auto"` 或 `"card"` 均可）
- 查看日志中是否有 `feishu streaming` 相关日志

## 配置参考

```yaml
streaming:
  enabled: true       # 是否启用（默认 false）
  throttleMs: 150     # 节流间隔 ms（默认 150，范围 100-5000）
  title: "AI 助手"    # 卡片标题（默认 "🤖 AI 助手"）
```

或简化为：

```yaml
streaming: true       # 使用默认配置
```

## 相关链接

- [飞书卡片实体 API](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/cardkit-v1/card/create)
- [卡片 JSON 2.0 结构](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-structure)
- [流式更新概述](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/streaming-updates-openapi-overview)
