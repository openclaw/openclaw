---
read_when:
  - 你想通过交互方式调整凭据、设备或智能体默认设置
summary: "`openclaw configure` 的 CLI 参考（交互式配置提示）"
title: configure
x-i18n:
  generated_at: "2026-02-01T19:58:46Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 9cb2bb5237b02b3a2dca71b5e43b11bd6b9939b9e4aa9ce1882457464b51efd2
  source_path: cli/configure.md
  workflow: 14
---

# `openclaw configure`

交互式提示，用于设置凭据、设备和智能体默认配置。

注意：**模型**部分现在包含一个多选项，用于设置
`agents.defaults.models` 允许列表（决定在 `/model` 和模型选择器中显示哪些模型）。

提示：不带子命令运行 `openclaw config` 会打开相同的向导。使用
`openclaw config get|set|unset` 进行非交互式编辑。

相关内容：

- Gateway网关配置参考：[配置](/gateway/configuration)
- Config CLI：[Config](/cli/config)

注意事项：

- 选择 Gateway网关运行位置时会始终更新 `gateway.mode`。如果你只需要修改这一项，可以直接选择"继续"而无需配置其他部分。
- 面向渠道的服务（Slack/Discord/Matrix/Microsoft Teams）在设置过程中会提示配置渠道/房间允许列表。你可以输入名称或 ID；向导会尽可能将名称解析为 ID。

## 示例

```bash
openclaw configure
openclaw configure --section models --section channels
```
