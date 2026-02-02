---
read_when:
  - 设置认证过期监控或告警
  - 自动化 Claude Code / Codex OAuth 刷新检查
summary: 监控模型提供商的 OAuth 过期状态
title: 认证监控
x-i18n:
  generated_at: "2026-02-01T19:36:14Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: eef179af9545ed7ab881f3ccbef998869437fb50cdb4088de8da7223b614fa2b
  source_path: automation/auth-monitoring.md
  workflow: 14
---

# 认证监控

OpenClaw 通过 `openclaw models status` 暴露 OAuth 过期健康状态。可将其用于自动化和告警；脚本是针对手机工作流的可选补充。

## 推荐方式：CLI 检查（跨平台通用）

```bash
openclaw models status --check
```

退出码：

- `0`：正常
- `1`：凭证已过期或缺失
- `2`：即将过期（24 小时内）

适用于 cron/systemd，无需额外脚本。

## 可选脚本（运维/手机工作流）

这些脚本位于 `scripts/` 目录下，属于**可选项**。它们假定你可以通过 SSH 访问 Gateway网关主机，并针对 systemd + Termux 进行了调优。

- `scripts/claude-auth-status.sh` 现在使用 `openclaw models status --json` 作为数据源（如果 CLI 不可用则回退到直接读取文件），因此请确保定时器中 `openclaw` 在 `PATH` 中。
- `scripts/auth-monitor.sh`：cron/systemd 定时器目标；发送告警（ntfy 或手机）。
- `scripts/systemd/openclaw-auth-monitor.{service,timer}`：systemd 用户定时器。
- `scripts/claude-auth-status.sh`：Claude Code + OpenClaw 认证检查器（完整/json/简洁模式）。
- `scripts/mobile-reauth.sh`：通过 SSH 进行引导式重新认证流程。
- `scripts/termux-quick-auth.sh`：一键小组件状态查看 + 打开认证 URL。
- `scripts/termux-auth-widget.sh`：完整的引导式小组件流程。
- `scripts/termux-sync-widget.sh`：将 Claude Code 凭证同步至 OpenClaw。

如果你不需要手机自动化或 systemd 定时器，可以跳过这些脚本。
