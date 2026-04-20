---
summary: "`openclaw configure`的CLI参考（交互式配置提示）"
read_when:
  - 您想以交互方式调整凭据、设备或代理默认值
title: "configure"
---

# `openclaw configure`

设置凭据、设备和代理默认值的交互式提示。

注意：**模型**部分现在包括`agents.defaults.models`允许列表的多选（显示在`/model`和模型选择器中的内容）。

当configure从提供者认证选择开始时，默认模型和允许列表选择器会自动优先选择该提供者。对于配对的提供者，如Volcengine/BytePlus，相同的偏好也匹配它们的编码计划变体（`volcengine-plan/*`、`byteplus-plan/*`）。如果首选提供者过滤器会产生空列表，configure会回退到未过滤的目录，而不是显示空白选择器。

提示：不带子命令的`openclaw config`会打开相同的向导。使用`openclaw config get|set|unset`进行非交互式编辑。

对于网络搜索，`openclaw configure --section web`允许您选择提供者并配置其凭据。一些提供者还会显示特定于提供者的后续提示：

- **Grok**可以提供可选的`x_search`设置，使用相同的`XAI_API_KEY`并让您选择`x_search`模型。
- **Kimi**可以询问Moonshot API区域（`api.moonshot.ai`与`api.moonshot.cn`）和默认的Kimi网络搜索模型。

相关：

- Gateway配置参考：[Configuration](/gateway/configuration)
- 配置CLI：[Config](/cli/config)

## 选项

- `--section <section>`: 可重复的部分过滤器

可用部分：

- `workspace`
- `model`
- `web`
- `gateway`
- `daemon`
- `channels`
- `plugins`
- `skills`
- `health`

注意事项：

- 选择Gateway运行的位置总是更新`gateway.mode`。如果这是您所需的全部，您可以选择"继续"而不选择其他部分。
- 面向通道的服务（Slack/Discord/Matrix/Microsoft Teams）在设置期间提示通道/房间允许列表。您可以输入名称或ID；向导会在可能的情况下将名称解析为ID。
- 如果您运行守护进程安装步骤，令牌认证需要令牌，并且`gateway.auth.token`由SecretRef管理，configure会验证SecretRef，但不会将解析的明文令牌值持久化到supervisor服务环境元数据中。
- 如果令牌认证需要令牌且配置的令牌SecretRef未解析，configure会阻止守护进程安装并提供可操作的补救指导。
- 如果同时配置了`gateway.auth.token`和`gateway.auth.password`且`gateway.auth.mode`未设置，configure会阻止守护进程安装，直到明确设置模式。

## 示例

```bash
openclaw configure
openclaw configure --section web
openclaw configure --section model --section channels
openclaw configure --section gateway --section daemon
```
