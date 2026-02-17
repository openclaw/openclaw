---
read_when:
  - 你想要 Gateway 网关、工作区、认证、渠道和 Skills 的引导式设置
summary: "`openclaw onboard` 的 CLI 参考（交互式新手引导向导）"
title: onboard
x-i18n:
  generated_at: "2026-02-03T07:45:00Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: a661049a6983233986a880a68440a3bcc6869ee2c4c6f5e9f3ab8ff973e22f60
  source_path: cli/onboard.md
  workflow: 15
---

# `openclaw onboard`

交互式新手引导向导（本地或远程 Gateway 网关设置）。

相关内容：

- 向导指南：[新手引导](/start/onboarding)

## 示例

```bash
openclaw onboard
openclaw onboard --flow quickstart
openclaw onboard --flow manual
openclaw onboard --mode remote --remote-url ws://gateway-host:18789
```

流程说明：

- `quickstart`：最少提示，自动生成 Gateway 网关令牌。
- `manual`：完整的端口/绑定/认证提示（`advanced` 的别名）。
- 最快开始聊天：`openclaw dashboard`（控制 UI，无需渠道设置）。
