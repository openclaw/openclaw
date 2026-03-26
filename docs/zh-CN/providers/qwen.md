---
read_when:
  - 你想在 OpenClaw 中使用 Qwen
  - 你之前使用过 Qwen OAuth
summary: 通过阿里云 Model Studio 使用 Qwen 模型
title: Qwen
x-i18n:
  generated_at: "2026-03-23T00:00:00Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: ""
  source_path: providers/qwen.md
  workflow: 15
---

# Qwen

<Warning>

**Qwen OAuth 已移除。** 使用 `portal.qwen.ai` 端点的免费层 OAuth 集成（`qwen-portal`）已不再可用。详情请参见 [Issue #49557](https://github.com/openclaw/openclaw/issues/49557)。

</Warning>

## 推荐方案：Model Studio（阿里云 Coding Plan）

使用 [Model Studio](/providers/modelstudio) 获取官方支持的 Qwen 模型访问（Qwen 3.5 Plus、GLM-4.7、Kimi K2.5、MiniMax M2.5 等）。

```bash
# 全球端点
openclaw onboard --auth-choice modelstudio-api-key

# 中国端点
openclaw onboard --auth-choice modelstudio-api-key-cn
```

完整设置详情请参见 [Model Studio](/providers/modelstudio)。
