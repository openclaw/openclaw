---
summary: "`openclaw logs`的CLI参考（通过RPC跟踪gateway日志）"
read_when:
  - 您需要远程跟踪Gateway日志（无需SSH）
  - 您希望为工具使用JSON日志行
title: "logs"
---

# `openclaw logs`

通过RPC跟踪Gateway文件日志（在远程模式下工作）。

相关：

- 日志概述：[Logging](/logging)
- Gateway CLI：[gateway](/cli/gateway)

## 选项

- `--limit <n>`: 返回的最大日志行数（默认`200`）
- `--max-bytes <n>`: 从日志文件读取的最大字节数（默认`250000`）
- `--follow`: 跟踪日志流
- `--interval <ms>`: 跟踪时的轮询间隔（默认`1000`）
- `--json`: 发出行分隔的JSON事件
- `--plain`: 无样式格式的纯文本输出
- `--no-color`: 禁用ANSI颜色
- `--local-time`: 在您的本地时区渲染时间戳

## 共享Gateway RPC选项

`openclaw logs`还接受标准Gateway客户端标志：

- `--url <url>`: Gateway WebSocket URL
- `--token <token>`: Gateway令牌
- `--timeout <ms>`: 超时（毫秒）（默认`30000`）
- `--expect-final`: 当Gateway调用由代理支持时等待最终响应

当您传递`--url`时，CLI不会自动应用配置或环境凭据。如果目标Gateway需要认证，请明确包含`--token`。

## 示例

```bash
openclaw logs
openclaw logs --follow
openclaw logs --follow --interval 2000
openclaw logs --limit 500 --max-bytes 500000
openclaw logs --json
openclaw logs --plain
openclaw logs --no-color
openclaw logs --limit 500
openclaw logs --local-time
openclaw logs --follow --local-time
openclaw logs --url ws://127.0.0.1:18789 --token "$OPENCLAW_GATEWAY_TOKEN"
```

## 注意事项

- 使用`--local-time`在您的本地时区渲染时间戳。
- 如果本地环回Gateway要求配对，`openclaw logs`会自动回退到配置的本地日志文件。显式的`--url`目标不使用此回退。
