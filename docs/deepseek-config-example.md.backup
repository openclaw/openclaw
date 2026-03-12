# DeepSeek 大模型配置指南

## 概述

本文档介绍如何在 OpenClaw 中配置 DeepSeek 大模型。DeepSeek 是一个强大的开源大语言模型，支持多种任务和功能。

## 环境变量配置

在 `.env` 文件中添加以下配置：

```bash
# DeepSeek API 密钥
DEEPSEEK_API_KEY=your-deepseek-api-key-here
```

## OpenClaw 配置文件示例

在 `openclaw.json` 配置文件中添加 DeepSeek 模型提供者：

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "deepseek": {
        "baseUrl": "https://api.deepseek.com",
        "apiKey": {
          "env": "DEEPSEEK_API_KEY"
        },
        "api": "openai-completions",
        "models": [
          {
            "id": "deepseek-chat",
            "name": "DeepSeek Chat",
            "reasoning": true,
            "input": ["text"],
            "cost": {
              "input": 0.14,
              "output": 0.28,
              "cacheRead": 0.0,
              "cacheWrite": 0.0
            },
            "contextWindow": 128000,
            "maxTokens": 4096
          },
          {
            "id": "deepseek-coder",
            "name": "DeepSeek Coder",
            "reasoning": true,
            "input": ["text"],
            "cost": {
              "input": 0.14,
              "output": 0.28,
              "cacheRead": 0.0,
              "cacheWrite": 0.0
            },
            "contextWindow": 128000,
            "maxTokens": 4096
          }
        ]
      }
    }
  }
}
```

## 配置说明

### 1. 基础配置
- **baseUrl**: DeepSeek API 端点
- **apiKey**: 从环境变量 `DEEPSEEK_API_KEY` 读取 API 密钥
- **api**: 使用 OpenAI 兼容的 API 格式

### 2. 模型列表
目前支持两个主要模型：

#### DeepSeek Chat
- **ID**: `deepseek-chat`
- **名称**: DeepSeek Chat
- **推理能力**: 支持
- **输入类型**: 文本
- **上下文窗口**: 128K tokens
- **最大输出**: 4096 tokens

#### DeepSeek Coder
- **ID**: `deepseek-coder`
- **名称**: DeepSeek Coder
- **推理能力**: 支持
- **输入类型**: 文本
- **上下文窗口**: 128K tokens
- **最大输出**: 4096 tokens

### 3. 成本配置
- **输入**: $0.14 每百万 tokens
- **输出**: $0.28 每百万 tokens
- **缓存**: 免费

## 使用示例

### 在会话中指定模型
```bash
# 使用 DeepSeek Chat 模型
openclaw --model deepseek/deepseek-chat

# 使用 DeepSeek Coder 模型
openclaw --model deepseek/deepseek-coder
```

### 在配置中设置默认模型
```json
{
  "defaultModel": "deepseek/deepseek-chat",
  "models": {
    // ... 模型配置
  }
}
```

## 注意事项

1. **API 密钥**: 需要从 DeepSeek 官网获取 API 密钥
2. **速率限制**: 注意 API 调用速率限制
3. **模型可用性**: 确保选择的模型在 API 中可用
4. **成本控制**: 监控 API 使用成本

## 故障排除

### 常见问题

1. **认证失败**
   - 检查 `DEEPSEEK_API_KEY` 环境变量是否正确设置
   - 验证 API 密钥是否有效

2. **模型不可用**
   - 检查模型 ID 是否正确
   - 确认 API 端点是否支持该模型

3. **网络问题**
   - 检查网络连接
   - 验证 API 端点可访问性

### 调试命令
```bash
# 检查环境变量
echo $DEEPSEEK_API_KEY

# 测试 API 连接
curl -H "Authorization: Bearer $DEEPSEEK_API_KEY" \
  https://api.deepseek.com/v1/models
```

## 更新日志

### 2026-03-04
- 初始版本：添加 DeepSeek 配置支持
- 支持 DeepSeek Chat 和 DeepSeek Coder 模型
- 添加完整的配置示例和文档