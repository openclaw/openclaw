---
summary: 通过 AIsa 在 OpenClaw 中生产级接入中国主流大模型（通义千问、DeepSeek、Kimi、GLM）
read_when:
  - 你想要生产级的中国大模型接入
  - 你想要通义千问折扣价格
  - 你需要一个 API key 访问所有中国大模型
  - 你需要 AIsa 配置指引
title: AIsa
---

# AIsa — 中国 AI 模型（生产级）

**AIsa** 通过单一 API key 提供中国主流大模型的生产级接入。作为阿里云通义千问的大客户合作伙伴，AIsa 以协议折扣价提供完整的 Qwen 模型家族，同时聚合了[阿里云百炼平台](https://bailian.console.alibabacloud.com/)上的所有模型——包括 Kimi（月之暗面）、DeepSeek、GLM（智谱）。

> **与 [Qwen Portal](/zh-CN/providers/qwen) 有什么区别？**
> Qwen Portal 使用免费层 OAuth 流程，仅限 2 个模型、每天 2,000 次请求。
> AIsa 提供完整的 Qwen 模型系列（Flash、Plus、Max、VL、Coder、Audio），无每日请求限制，享受大客户协议价。

## 为什么选择 AIsa

- **完整 Qwen 模型家族** — Flash、Plus、Max、VL、Coder、Audio 等，不只 2 个模型。
- **大客户协议价** — 通过阿里云合作伙伴关系获得 Qwen 模型折扣。
- **所有中国模型，一个 key** — 通义千问、Kimi（月之暗面）、DeepSeek、GLM（智谱），通过百炼聚合平台统一接入。
- **无每日请求限制** — 面向生产环境，非免费试用。
- **OpenAI 兼容** — 标准 `/v1` 接口，兼容所有 OpenAI SDK。

## 默认模型

配置 AIsa 后，以下三个模型开箱即用：

| 模型 ID         | 名称          | 开发商   | 最佳用途         | 上下文 | 视觉   |
| --------------- | ------------- | -------- | ---------------- | ------ | ------ |
| `qwen3-max`     | Qwen3 Max     | 阿里巴巴 | 通用（默认模型） | 256k   | 支持   |
| `deepseek-v3.1` | DeepSeek V3.1 | 深度求索 | 推理             | 128k   | 不支持 |
| `kimi-k2.5`     | Kimi K2.5     | 月之暗面 | 长上下文任务     | 256k   | 不支持 |

## 完整模型目录

除默认模型外，AIsa 还提供完整的 Qwen 家族和百炼平台上所有模型的访问。

### 通义千问家族（阿里巴巴）— 大客户协议价

| 模型 ID                      | 名称             | 最佳用途     |
| ---------------------------- | ---------------- | ------------ |
| `qwen3-max`                  | Qwen3 Max        | 复杂推理     |
| `qwen-plus`                  | Qwen Plus        | 性价比均衡   |
| `qwen-turbo`                 | Qwen Turbo       | 快速、低成本 |
| `qwen-vl-max`                | Qwen VL Max      | 图像理解     |
| `qwen2.5-coder-32b-instruct` | Qwen Coder 32B   | 代码生成     |
| `qwen-audio-turbo`           | Qwen Audio Turbo | 音频理解     |

### 其他中国模型（通过百炼平台）

| 模型 ID         | 名称          | 开发商                  |
| --------------- | ------------- | ----------------------- |
| `deepseek-v3.1` | DeepSeek V3.1 | DeepSeek（深度求索）    |
| `deepseek-r1`   | DeepSeek R1   | DeepSeek（深度求索）    |
| `kimi-k2.5`     | Kimi K2.5     | Moonshot AI（月之暗面） |

完整模型目录和价格请访问 [marketplace.aisa.one/pricing](https://marketplace.aisa.one/pricing)。

## 快速开始

### 1. 获取 API Key

1. 访问 [AIsa Marketplace](https://marketplace.aisa.one/)
2. 注册或登录
3. 进入 API Keys 页面，生成新密钥
4. 复制密钥

新用户注册即获最低 $1 赠送额度。

### 2. 配置 OpenClaw

**方式 A：交互式设置（推荐）**

```bash
openclaw onboard --auth-choice aisa-api-key
```

**方式 B：环境变量**

```bash
export AISA_API_KEY="your-api-key-here"
```

### 3. 验证

```bash
openclaw models set aisa/qwen3-max
openclaw tui
```

## 如何选择模型？

| 使用场景       | 推荐模型                     | 原因                  |
| -------------- | ---------------------------- | --------------------- |
| **日常对话**   | `qwen3-max`                  | Qwen 最强模型（默认） |
| **性价比**     | `qwen-plus`                  | 质量好、成本更低      |
| **快速低成本** | `qwen-turbo`                 | 最低延迟和成本        |
| **代码生成**   | `qwen2.5-coder-32b-instruct` | 代码优化模型          |
| **图像理解**   | `qwen-vl-max`                | 视觉理解              |
| **深度推理**   | `deepseek-r1`                | 链式思维推理          |
| **长上下文**   | `kimi-k2.5`                  | 256k 上下文窗口       |

随时切换默认模型：

```bash
openclaw models set aisa/qwen3-max
openclaw models set aisa/deepseek-v3.1
openclaw models set aisa/kimi-k2.5
```

## 配置

完成配置后，你的 `openclaw.json` 将包含：

```json5
{
  models: {
    providers: {
      aisa: {
        baseUrl: "https://api.aisa.one/v1",
        api: "openai-completions",
        models: [
          { id: "qwen3-max", name: "Qwen3 Max" },
          { id: "deepseek-v3.1", name: "DeepSeek V3.1" },
          { id: "kimi-k2.5", name: "Kimi K2.5" },
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "aisa/qwen3-max" },
    },
  },
}
```

## 使用示例

```bash
# 启动 TUI 使用默认模型
openclaw tui

# 在模型间切换
openclaw models set aisa/qwen3-max
openclaw models set aisa/deepseek-v3.1
openclaw models set aisa/kimi-k2.5
```

## AIsa 与 Qwen Portal 对比

| 对比项       | AIsa                                 | Qwen Portal（OAuth）      |
| ------------ | ------------------------------------ | ------------------------- |
| **模型数量** | 完整 Qwen 家族 + DeepSeek、Kimi、GLM | 2 个模型（Coder、Vision） |
| **每日限制** | 无上限                               | 每天 2,000 次请求         |
| **价格**     | 大客户协议折扣                       | 免费层                    |
| **其他厂商** | DeepSeek、Kimi、GLM                  | 仅 Qwen                   |
| **适用场景** | 生产环境                             | 快速测试                  |

## 故障排查

### API key 未识别

```bash
echo $AISA_API_KEY
openclaw models list | grep aisa
```

### 连接问题

AIsa API 地址为 `https://api.aisa.one/v1`，请确保网络允许 HTTPS 连接。

## 相关文档

- [Qwen Portal（免费层）](/zh-CN/providers/qwen)
- [OpenClaw 配置](/zh-CN/gateway/configuration)
- [模型提供商](/zh-CN/concepts/model-providers)
- [AIsa API 文档](https://aisa.mintlify.app/api-reference/introduction)
