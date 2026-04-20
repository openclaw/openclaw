---
summary: "从命令行运行代理回合并可选择将回复传递到频道"
read_when:
  - 你想从脚本或命令行触发代理运行
  - 你需要以编程方式将代理回复传递到聊天频道
title: "代理发送"
---

# 代理发送

`openclaw agent` 从命令行运行单个代理回合，无需入站聊天消息。适用于脚本化工作流、测试和程序化传递。

## 快速开始

<Steps>
  <Step title="运行简单的代理回合">
    ```bash
    openclaw agent --message "今天天气怎么样？"
    ```

    这会通过网关发送消息并打印回复。

  </Step>

  <Step title="目标特定代理或会话">
    ```bash
    # 目标特定代理
    openclaw agent --agent ops --message "总结日志"

    # 目标电话号码（派生会话密钥）
    openclaw agent --to +15555550123 --message "状态更新"

    # 重用现有会话
    openclaw agent --session-id abc123 --message "继续任务"
    ```

  </Step>

  <Step title="将回复传递到频道">
    ```bash
    # 传递到 WhatsApp（默认频道）
    openclaw agent --to +15555550123 --message "报告已准备"

    # 传递到 Slack
    openclaw agent --agent ops --message "生成报告" \
      --deliver --reply-channel slack --reply-to "#reports"
    ```

  </Step>
</Steps>

## 标志

| 标志                          | 描述                                                 |
| ----------------------------- | ----------------------------------------------------------- |
| `--message \<text\>`          | 要发送的消息（必需）                                  |
| `--to \<dest\>`               | 从目标派生会话密钥（电话、聊天 ID）           |
| `--agent \<id\>`              | 目标配置的代理（使用其 `main` 会话）         |
| `--session-id \<id\>`         | 通过 ID 重用现有会话                             |
| `--local`                     | 强制本地嵌入式运行时（跳过网关）                 |
| `--deliver`                   | 将回复发送到聊天频道                            |
| `--channel \<name\>`          | 传递频道（whatsapp、telegram、discord、slack 等） |
| `--reply-to \<target\>`       | 传递目标覆盖                                    |
| `--reply-channel \<name\>`    | 传递频道覆盖                                   |
| `--reply-account \<id\>`      | 传递账户 ID 覆盖                                |
| `--thinking \<level\>`        | 设置思考级别（off、minimal、low、medium、high、xhigh） |
| `--verbose \<on\|full\|off\>` | 设置详细级别                                           |
| `--timeout \<seconds\>`       | 覆盖代理超时                                      |
| `--json`                      | 输出结构化 JSON                                      |

## 行为

- 默认情况下，CLI **通过网关**。添加 `--local` 强制在当前机器上使用嵌入式运行时。
- 如果网关不可达，CLI **回退**到本地嵌入式运行。
- 会话选择：`--to` 派生会话密钥（组/频道目标保持隔离；直接聊天折叠到 `main`）。
- 思考和详细标志会持久化到会话存储中。
- 输出：默认情况下为纯文本，或使用 `--json` 获取结构化负载和元数据。

## 示例

```bash
# 带有 JSON 输出的简单回合
openclaw agent --to +15555550123 --message "跟踪日志" --verbose on --json

# 带有思考级别的回合
openclaw agent --session-id 1234 --message "总结收件箱" --thinking medium

# 传递到与会话不同的频道
openclaw agent --agent ops --message "警报" --deliver --reply-channel telegram --reply-to "@admin"
```

## 相关

- [代理 CLI 参考](/cli/agent)
- [子代理](/tools/subagents) — 后台子代理生成
- [会话](/concepts/session) — 会话密钥如何工作