---
read_when:
  - 更改仪表盘认证或暴露模式
summary: Gateway网关仪表盘（控制 UI）访问与认证
title: 仪表盘
x-i18n:
  generated_at: "2026-02-01T21:44:08Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: e6876d50e17d3dd741471ed78bef6ac175b2fdbdc1c45dd52d9d2bd013e17f31
  source_path: web/dashboard.md
  workflow: 15
---

# 仪表盘（控制 UI）

Gateway网关仪表盘是默认在 `/` 路径提供的浏览器控制 UI（可通过 `gateway.controlUi.basePath` 覆盖）。

快速打开（本地 Gateway网关）：

- http://127.0.0.1:18789/（或 http://localhost:18789/）

关键参考：

- [控制 UI](/web/control-ui) 了解使用方式和 UI 功能。
- [Tailscale](/gateway/tailscale) 了解 Serve/Funnel 自动化。
- [Web 界面](/web) 了解绑定模式和安全说明。

认证在 WebSocket 握手时通过 `connect.params.auth`（令牌或密码）强制执行。参见 [Gateway网关配置](/gateway/configuration) 中的 `gateway.auth`。

安全说明：控制 UI 是一个**管理界面**（聊天、配置、执行审批）。不要将其公开暴露。UI 在首次加载后将令牌存储在 `localStorage` 中。建议使用 localhost、Tailscale Serve 或 SSH 隧道。

## 快速路径（推荐）

- 完成新手引导后，CLI 会自动打开携带令牌的仪表盘，并打印相同的带令牌链接。
- 随时重新打开：`openclaw dashboard`（复制链接，如可能则打开浏览器，无头环境下显示 SSH 提示）。
- 令牌保留在本地（仅作为查询参数）；UI 在首次加载后会移除它并保存到 localStorage 中。

## 令牌基础（本地 vs 远程）

- **Localhost**：打开 `http://127.0.0.1:18789/`。如果看到"unauthorized"，运行 `openclaw dashboard` 并使用带令牌的链接（`?token=...`）。
- **令牌来源**：`gateway.auth.token`（或 `OPENCLAW_GATEWAY_TOKEN`）；UI 在首次加载后存储它。
- **非 localhost**：使用 Tailscale Serve（当 `gateway.auth.allowTailscale: true` 时无需令牌）、带令牌的 tailnet 绑定，或 SSH 隧道。参见 [Web 界面](/web)。

## 如果看到"unauthorized"/ 1008

- 运行 `openclaw dashboard` 获取新的带令牌链接。
- 确保 Gateway网关可达（本地：`openclaw status`；远程：SSH 隧道 `ssh -N -L 18789:127.0.0.1:18789 user@host`，然后打开 `http://127.0.0.1:18789/?token=...`）。
- 在仪表盘设置中，粘贴你在 `gateway.auth.token`（或 `OPENCLAW_GATEWAY_TOKEN`）中配置的相同令牌。
