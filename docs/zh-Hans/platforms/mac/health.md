---
read_when:
  - 调试 Mac 应用健康指示器
summary: macOS 应用如何报告 Gateway 网关/Baileys 健康状态
title: 健康检查
x-i18n:
  generated_at: "2026-02-03T07:52:40Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 0560e96501ddf53a499f8960cfcf11c2622fcb9056bfd1bcc57876e955cab03d
  source_path: platforms/mac/health.md
  workflow: 15
---

# macOS 上的健康检查

如何从菜单栏应用查看关联渠道是否健康。

## 菜单栏

- 状态圆点现在反映 Baileys 健康状态：
  - 绿色：已关联 + socket 最近已打开。
  - 橙色：正在连接/重试。
  - 红色：已登出或探测失败。
- 第二行显示"linked · auth 12m"或显示失败原因。
- "Run Health Check"菜单项触发按需探测。

## 设置

- 通用选项卡新增健康卡片，显示：关联认证时间、会话存储路径/数量、上次检查时间、上次错误/状态码，以及运行健康检查/显示日志按钮。
- 使用缓存快照，因此 UI 立即加载，离线时优雅降级。
- **渠道选项卡**显示渠道状态 + WhatsApp/Telegram 的控制（登录二维码、登出、探测、上次断开/错误）。

## 探测工作原理

- 应用每约 60 秒和按需时通过 `ShellExecutor` 运行 `openclaw health --json`。探测加载凭证并报告状态，不发送消息。
- 分别缓存上次成功的快照和上次错误以避免闪烁；显示每个的时间戳。

## 有疑问时

- 你仍然可以使用 [Gateway 网关健康](/gateway/health) 中的 CLI 流程（`openclaw status`、`openclaw status --deep`、`openclaw health --json`），并在 `/tmp/openclaw/openclaw-*.log` 中跟踪 `web-heartbeat` / `web-reconnect`。
