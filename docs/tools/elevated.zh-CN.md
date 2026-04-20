---
summary: "Elevated exec 模式：从沙盒化代理运行沙盒外的命令"
read_when:
  - 调整 elevated 模式默认值、允许列表或斜杠命令行为
  - 了解沙盒化代理如何访问主机
title: "Elevated 模式"
---

# Elevated 模式

当代理在沙盒内运行时，其 `exec` 命令被限制在沙盒环境中。**Elevated 模式** 允许代理突破限制，在沙盒外运行命令，具有可配置的审批门控。

<Info>
  Elevated 模式仅在代理**被沙盒化**时改变行为。对于非沙盒化代理，exec 已经在主机上运行。
</Info>

## 指令

使用斜杠命令按会话控制 elevated 模式：

| 指令          | 功能                                                           |
| -------------- | -------------------------------------------------------------- |
| `/elevated on`   | 在配置的主机路径上在沙盒外运行，保持审批                        |
| `/elevated ask`  | 与 `on` 相同（别名）                                           |
| `/elevated full` | 在配置的主机路径上在沙盒外运行并跳过审批                       |
| `/elevated off`  | 返回沙盒限制的执行                                             |

也可作为 `/elev on|off|ask|full` 使用。

发送 `/elevated` 无参数可查看当前级别。

## 工作原理

<Steps>
  <Step title="检查可用性">
    Elevated 必须在配置中启用，且发送者必须在允许列表中：

    ```json5
    {
      tools: {
        elevated: {
          enabled: true,
          allowFrom: {
            discord: ["user-id-123"],
            whatsapp: ["+15555550123"],
          },
        },
      },
    }
    ```

  </Step>

  <Step title="设置级别">
    发送仅包含指令的消息以设置会话默认值：

    ```
    /elevated full
    ```

    或内联使用（仅适用于该消息）：

    ```
    /elevated on run the deployment script
    ```

  </Step>

  <Step title="在沙盒外运行命令">
    启用 elevated 后，`exec` 调用离开沙盒。有效主机默认为 `gateway`，或当配置的/会话 exec 目标为 `node` 时为 `node`。在 `full` 模式下，跳过 exec 审批。在 `on`/`ask` 模式下，仍应用配置的审批规则。
  </Step>
</Steps>

## 解析顺序

1. **消息上的内联指令**（仅适用于该消息）
2. **会话覆盖**（通过发送仅包含指令的消息设置）
3. **全局默认值**（配置中的 `agents.defaults.elevatedDefault`）

## 可用性和允许列表

- **全局门控**：`tools.elevated.enabled`（必须为 `true`）
- **发送者允许列表**：`tools.elevated.allowFrom` 带按通道列表
- **按代理门控**：`agents.list[].tools.elevated.enabled`（只能进一步限制）
- **按代理允许列表**：`agents.list[].tools.elevated.allowFrom`（发送者必须同时匹配全局和按代理）
- **Discord 回退**：如果省略 `tools.elevated.allowFrom.discord`，则使用 `channels.discord.allowFrom` 作为回退
- **所有门控必须通过**；否则 elevated 被视为不可用

允许列表条目格式：

| 前缀                  | 匹配                         |
| ----------------------- | ------------------------------- |
| (无)                  | 发送者 ID、E.164 或 From 字段 |
| `name:`                 | 发送者显示名称             |
| `username:`             | 发送者用户名                 |
| `tag:`                  | 发送者标签                      |
| `id:`, `from:`, `e164:` | 显式身份目标                 |

## Elevated 不控制的内容

- **工具策略**：如果 `exec` 被工具策略拒绝，elevated 无法覆盖它
- **主机选择策略**：elevated 不会将 `auto` 变成自由的跨主机覆盖。它使用配置的/会话 exec 目标规则，仅当目标已经是 `node` 时才选择 `node`。
- **与 `/exec` 分开**：`/exec` 指令为授权发送者调整每会话 exec 默认值，不需要 elevated 模式

## 相关

- [Exec 工具](/tools/exec) — shell 命令执行
- [Exec 审批](/tools/exec-approvals) — 审批和允许列表系统
- [沙盒化](/gateway/sandboxing) — 沙盒配置
- [沙盒 vs 工具策略 vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)