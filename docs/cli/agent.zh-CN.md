---
summary: "`openclaw agent`的CLI参考（通过Gateway发送一个代理回合）"
read_when:
  - 您想从脚本运行一个代理回合（可选地传递回复）
title: "agent"
---

# `openclaw agent`

通过Gateway运行一个代理回合（使用`--local`进行嵌入式运行）。
使用`--agent <id>`直接针对配置的代理。

传递至少一个会话选择器：

- `--to <dest>`
- `--session-id <id>`
- `--agent <id>`

相关：

- 代理发送工具：[Agent send](/tools/agent-send)

## 选项

- `-m, --message <text>`: 必填消息体
- `-t, --to <dest>`: 用于派生会话密钥的收件人
- `--session-id <id>`: 显式会话ID
- `--agent <id>`: 代理ID；覆盖路由绑定
- `--thinking <off|minimal|low|medium|high|xhigh>`: 代理思考级别
- `--verbose <on|off>`: 为会话持久化详细级别
- `--channel <channel>`: 传递通道；省略以使用主会话通道
- `--reply-to <target>`: 传递目标覆盖
- `--reply-channel <channel>`: 传递通道覆盖
- `--reply-account <id>`: 传递账户覆盖
- `--local`: 直接运行嵌入式代理（在插件注册表预加载后）
- `--deliver`: 将回复发送回选定的通道/目标
- `--timeout <seconds>`: 覆盖代理超时（默认600或配置值）
- `--json`: 输出JSON

## 示例

```bash
openclaw agent --to +15555550123 --message "status update" --deliver
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --to +15555550123 --message "Trace logs" --verbose on --json
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
openclaw agent --agent ops --message "Run locally" --local
```

## 注意事项

- 当Gateway请求失败时，Gateway模式会回退到嵌入式代理。使用`--local`强制预先执行嵌入式运行。
- `--local`仍然会首先预加载插件注册表，因此在嵌入式运行期间，插件提供的提供者、工具和通道仍然可用。
- `--channel`、`--reply-channel`和`--reply-account`影响回复传递，而不是会话路由。
- 当此命令触发`models.json`再生时，SecretRef管理的提供者凭据会以非秘密标记（例如环境变量名称、`secretref-env:ENV_VAR_NAME`或`secretref-managed`）的形式持久化，而不是解析的秘密明文。
- 标记写入是源权威的：OpenClaw从活动源配置快照中持久化标记，而不是从解析的运行时秘密值中持久化。
