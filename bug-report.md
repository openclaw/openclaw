# Moltbot 空响应 Bug 报告

## 🐛 Bug 描述

Moltbot Gateway 在 WebChat 中显示空的 Assistant 响应，即使 API（OpenAI 和 Google Gemini）返回了正确的内容。

## 📊 症状

1. **WebChat 显示空响应**：
   - 只显示 "Assistant" 标签和时间戳
   - 没有任何文本内容
   - 按钮从 "Stop" 变成 "Send"，说明 agent 已完成

2. **日志显示成功**：
   - `embedded run done: aborted=false` ✅
   - 没有任何错误信息
   - Agent 正常完成运行

3. **API 返回正常**：
   - 直接测试 OpenAI API：返回 `insufficient_quota` 错误（配额问题）
   - 直接测试 Gemini API：返回正确的文本内容 ✅

## 🔬 测试证据

### Gemini 2.0 Flash 测试

**直接 API 调用**：
```bash
curl -x http://192.168.1.110:8899 \
  -H 'Content-Type: application/json' \
  -d '{"contents":[{"parts":[{"text":"你好，请用中文回复\"收到\""}]}]}' \
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=AIzaSyCB..."
```

**返回**：
```json
{
  "candidates": [{
    "content": {
      "parts": [{"text": "收到。\n"}],
      "role": "model"
    },
    "finishReason": "STOP"
  }]
}
```

✅ **API 返回了正确的内容："收到。"**

**Moltbot WebChat 测试**：
- 发送消息："Gemini 2.0 测试：你好，请用中文回复\"收到\""
- 结果：Assistant 回复为空（只显示标签和时间）
- 日志：`embedded run done: durationMs=56381 aborted=false`

❌ **Moltbot 没有显示任何内容**

### OpenAI GPT-4o-mini 测试

**直接 API 调用**：
```bash
curl -x http://192.168.1.110:8899 \
  -H "Authorization: Bearer sk-proj-..." \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"你好"}]}'
```

**返回**：
```json
{
  "error": {
    "message": "You exceeded your current quota",
    "type": "insufficient_quota"
  }
}
```

❌ **OpenAI 配额用完（这是预期的错误）**

**Moltbot WebChat 测试**：
- 发送消息："OpenAI 配置成功测试：你好"
- 结果：Assistant 回复为空
- 日志：`embedded run done: durationMs=33063 aborted=false`

❌ **Moltbot 没有显示错误信息**

## 🔍 根本原因分析

### 问题 1：响应文本提取失败

Moltbot 的 `buildEmbeddedRunPayloads` 函数（`src/agents/pi-embedded-runner/run/payloads.ts`）负责从 API 响应中提取文本。

可能的原因：
1. `assistantTexts` 数组为空
2. `extractAssistantText()` 函数无法正确解析 Gemini 2.0 的响应格式
3. 文本被 `shouldSuppressRawErrorText()` 或其他过滤器过滤掉了

### 问题 2：错误信息不显示

当 OpenAI 返回 `insufficient_quota` 错误时，Moltbot 应该：
1. 检测到 API 错误
2. 在 WebChat 中显示友好的错误信息
3. 提示用户检查 API 配额

但实际上，Moltbot 只是返回空响应，没有任何错误提示。

## 🛠️ 复现步骤

### 环境
- Moltbot 版本：2026.1.27-beta.1
- 部署方式：Docker Compose
- 操作系统：Synology NAS (Linux)
- 代理：mihomo (http://192.168.1.110:8899)

### 配置

**moltbot.json**：
```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "google/gemini-2.0-flash"
      },
      "models": {
        "google/gemini-2.0-flash": {},
        "openai/gpt-4o-mini": {}
      }
    }
  },
  "env": {
    "GOOGLE_API_KEY": "AIzaSyCB-kAc2xCTwLAVBBmGs6Up7NKAg03PQ5Q",
    "HTTP_PROXY": "http://192.168.1.110:8899",
    "HTTPS_PROXY": "http://192.168.1.110:8899"
  }
}
```

**auth-profiles.json**：
```json
{
  "version": 1,
  "profiles": {
    "google:default": {
      "type": "api_key",
      "provider": "google",
      "key": "AIzaSyCB-kAc2xCTwLAVBBmGs6Up7NKAg03PQ5Q"
    }
  }
}
```

### 复现步骤

1. 配置 Moltbot 使用 `google/gemini-2.0-flash` 模型
2. 在 WebChat 中发送任意消息
3. 观察 Assistant 回复为空
4. 检查日志：`embedded run done: aborted=false`（成功完成）
5. 直接测试 Gemini API：返回正确内容

## 💡 建议修复

### 1. 改进响应解析

在 `src/agents/pi-embedded-runner/run/payloads.ts` 中：
- 添加调试日志，记录 `assistantTexts` 的内容
- 检查 `extractAssistantText()` 是否正确处理 Gemini 2.0 的响应格式
- 确保文本不会被意外过滤

### 2. 改进错误处理

当 API 返回错误时：
- 检测错误类型（quota, rate_limit, invalid_key 等）
- 在 WebChat 中显示友好的错误信息
- 提供可操作的建议（如"请检查 API 配额"）

### 3. 添加诊断工具

- 在 WebChat 中添加"显示原始响应"选项
- 在日志中记录 API 响应的完整内容
- 提供调试模式，显示响应解析的每个步骤

## 📝 相关文件

- `src/agents/pi-embedded-runner/run.ts` - Agent 运行逻辑
- `src/agents/pi-embedded-runner/run/payloads.ts` - 响应解析逻辑
- `src/agents/pi-embedded-subscribe.ts` - 响应订阅和文本提取
- `src/agents/pi-embedded-utils.ts` - 文本提取工具函数

## 🔗 相关 Issue

- 这个 bug 影响所有使用 Gemini 2.0 和 OpenAI 的用户
- 可能与 Gemini 3.0 的空响应问题相关
- 需要检查 Moltbot 对不同 API 版本的兼容性

## ✅ 临时解决方案

目前没有有效的解决方案。建议：
1. 等待 Moltbot 官方修复
2. 或者使用其他支持良好的模型（如 Claude）
3. 向 OpenClaw 项目提交 Issue

---

**报告时间**: 2026-01-30 16:55
**报告人**: Kiro AI Assistant
**严重程度**: 高（核心功能无法使用）
**影响范围**: Gemini 2.0, OpenAI, 可能还有其他 provider
