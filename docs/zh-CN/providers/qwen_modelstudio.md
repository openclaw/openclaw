---
title: "Qwen / Model Studio"
summary: "阿里云 Model Studio 设置（标准按量付费和编码计划、双区域端点）"
read_when:
  - 您想将 Qwen（阿里云 Model Studio）与 OpenClaw 一起使用
  - 您需要 Model Studio 的 API 密钥环境变量
  - 您想使用 Standard（按量付费）或 Coding Plan 端点
---

# Qwen / Model Studio（阿里云）

Model Studio 提供商提供对阿里云模型的访问，包括 Qwen 和托管在平台上的第三方模型。支持两种计费计划：**Standard**（按量付费）和 **Coding Plan**（订阅）。

- 提供商：`modelstudio`
- 认证：`MODELSTUDIO_API_KEY`
- API：OpenAI 兼容

## 快速开始

### Standard（按量付费）

```bash
# 中国端点
openclaw onboard --auth-choice modelstudio-standard-api-key-cn

# 全球/国际端点
openclaw onboard --auth-choice modelstudio-standard-api-key
```

### Coding Plan（订阅）

```bash
# 中国端点
openclaw onboard --auth-choice modelstudio-api-key-cn

# 全球/国际端点
openclaw onboard --auth-choice modelstudio-api-key
```

引导后，设置默认模型：

```json5
{
  agents: {
    defaults: {
      model: { primary: "modelstudio/qwen3.5-plus" },
    },
  },
}
```

## 计划类型和端点

| 计划 | 区域 | 认证选项 | 端点 |
| -------------------------- | ------ | --------------------------------- | ------------------------------------------------ |
| Standard（按量付费） | 中国 | `modelstudio-standard-api-key-cn` | `dashscope.aliyuncs.com/compatible-mode/v1` |
| Standard（按量付费） | 全球 | `modelstudio-standard-api-key` | `dashscope-intl.aliyuncs.com/compatible-mode/v1` |
| Coding Plan（订阅） | 中国 | `modelstudio-api-key-cn` | `coding.dashscope.aliyuncs.com/v1` |
| Coding Plan（订阅） | 全球 | `modelstudio-api-key` | `coding-intl.dashscope.aliyuncs.com/v1` |

提供商根据您的认证选择自动选择端点。您可以在配置中通过自定义 `baseUrl` 覆盖。

## 获取您的 API 密钥

- **中国**：[bailian.console.aliyun.com](https://bailian.console.aliyun.com/)
- **全球/国际**：[modelstudio.console.alibabacloud.com](https://modelstudio.console.alibabacloud.com/)

## 可用模型

- **qwen3.5-plus**（默认）— Qwen 3.5 Plus
- **qwen3-coder-plus**、**qwen3-coder-next** — Qwen 编码模型
- **GLM-5** — 通过阿里云的 GLM 模型
- **Kimi K2.5** — 通过阿里云的 Moonshot AI
- **MiniMax-M2.5** — 通过阿里海的 MiniMax

一些模型（qwen3.5-plus、kimi-k2.5）支持图像输入。上下文窗口范围从 200K 到 1M tokens。

## 环境说明

如果 Gateway 作为守护进程运行（launchd/systemd），请确保 `MODELSTUDIO_API_KEY` 对该进程可用（例如，在 `~/.openclaw/.env` 中或通过 `env.shellEnv`）。