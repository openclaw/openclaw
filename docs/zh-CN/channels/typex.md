---
summary: "TypeX 渠道接入与配置"
read_when:
  - 你需要把 OpenClaw 连接到 TypeX
  - 你要配置 TypeX 二维码登录
title: "TypeX"
---

# TypeX

TypeX 以插件渠道提供。

## 需要先安装插件

```bash
openclaw plugins install @openclaw/typex
```

本地源码方式：

```bash
openclaw plugins install ./extensions/typex
```

## 快速配置

1. 运行：

```bash
openclaw channels add
```

2. 选择 **TypeX**。
3. 按提示扫码登录。
4. 登录成功后会把 `token` 写入 `channels.typex.accounts.<userId>`。

## 最小配置示例

```json5
{
  channels: {
    typex: {
      enabled: true,
      defaultAccount: "<user_id>",
      accounts: {
        "<user_id>": {
          token: "sessionid=...",
        },
      },
    },
  },
}
```

## 能力

- 私聊：支持
- 媒体发送：暂不支持
- Reactions：不支持
- Threads：不支持
- Polls：不支持

## 说明

- 入站消息通过 TypeX API 轮询获取。
- 偏移量 `pos` 保存在 state 文件（`~/.openclaw/typex/`）中。
- 默认目标提示为 `chat_id`。
