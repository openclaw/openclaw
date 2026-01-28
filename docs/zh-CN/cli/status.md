---
read_when:
  - 你想快速诊断渠道健康状况及近期会话接收者
  - 你想获取可粘贴的完整状态信息用于调试
summary: "`openclaw status`（诊断、探测、使用情况快照）的 CLI 参考"
title: status
x-i18n:
  generated_at: "2026-02-01T20:21:30Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 2bbf5579c48034fc15c2cbd5506c50456230b17e4a74c06318968c590d8f1501
  source_path: cli/status.md
  workflow: 14
---

# `openclaw status`

渠道和会话的诊断信息。

```bash
openclaw status
openclaw status --all
openclaw status --deep
openclaw status --usage
```

说明：

- `--deep` 会运行实时探测（WhatsApp Web + Telegram + Discord + Google Chat + Slack + Signal）。
- 当配置了多个智能体时，输出包含每个智能体的会话存储。
- 概览包含 Gateway网关和节点主机服务的安装/运行状态（如可用）。
- 概览包含更新渠道和 git SHA（适用于源码检出）。
- 更新信息会显示在概览中；如果有可用更新，状态会提示运行 `openclaw update`（参见[更新](/install/updating)）。
