---
read_when:
  - 你想快速诊断渠道健康状况 + 最近的会话接收者
  - 你想获取可粘贴的"all"状态用于调试
summary: "`openclaw status` 的 CLI 参考（诊断、探测、使用量快照）"
title: status
x-i18n:
  generated_at: "2026-02-03T07:45:21Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 2bbf5579c48034fc15c2cbd5506c50456230b17e4a74c06318968c590d8f1501
  source_path: cli/status.md
  workflow: 15
---

# `openclaw status`

渠道 + 会话的诊断。

```bash
openclaw status
openclaw status --all
openclaw status --deep
openclaw status --usage
```

注意事项：

- `--deep` 运行实时探测（WhatsApp Web + Telegram + Discord + Google Chat + Slack + Signal）。
- 当配置了多个智能体时，输出包含每个智能体的会话存储。
- 概览包含 Gateway 网关 + 节点主机服务安装/运行时状态（如果可用）。
- 概览包含更新渠道 + git SHA（用于源代码检出）。
- 更新信息显示在概览中；如果有可用更新，status 会打印提示运行 `openclaw update`（参见[更新](/install/updating)）。
