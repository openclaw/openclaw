---
summary: "Linux support + companion app status"
read_when:
  - 尋找 Linux 夥伴應用程式狀態
  - 規劃平台涵蓋或貢獻
title: "Linux 應用程式"
---

# Linux 應用程式

閘道在 Linux 上已完全支援。 **Node 是建議的執行環境**。
不建議在閘道使用 Bun（WhatsApp/Telegram 有錯誤）。

原生的 Linux 夥伴應用程式正在規劃中。 Contributions are welcome if you want to help build one.

## 初學者快速路徑（VPS）

1. 安裝 Node 22+
2. `npm i -g openclaw@latest`
3. `openclaw onboard --install-daemon`
4. 從您的筆電：`ssh -N -L 18789:127.0.0.1:18789 <user>@<host>`
5. 開啟 `http://127.0.0.1:18789/` 並貼上您的權杖

逐步 VPS 指南：[exe.dev](/install/exe-dev)

## 安裝

- [入門指南](/start/getting-started)
- [安裝與更新](/install/updating)
- 選用流程：[Bun（實驗性）](/install/bun)、[Nix](/install/nix)、[Docker](/install/docker)

## Gateway 閘道器

- [Gateway 閘道器操作手冊](/gateway)
- [設定](/gateway/configuration)

## Gateway 閘道器服務安裝（CLI）

使用以下其中一種：

```
openclaw onboard --install-daemon
```

或：

```
openclaw gateway install
```

或：

```
openclaw configure
```

出現提示時，請選擇 **Gateway service**。

修復／遷移：

```
openclaw doctor
```

## 系統控制（systemd 使用者單位）

OpenClaw 預設會安裝 systemd **使用者** 服務。對於共用或永遠開啟的伺服器，請使用 **系統** 服務。完整的單位範例與指引位於 [Gateway 閘道器操作手冊](/gateway)。 對於共用或永遠在線的伺服器，請使用 **system**
服務。 The full unit example and guidance
live in the [Gateway runbook](/gateway).

最小設定：

建立 `~/.config/systemd/user/openclaw-gateway[-<profile>].service`：

```
[Unit]
Description=OpenClaw Gateway (profile: <profile>, v<version>)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/openclaw gateway --port 18789
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

啟用它：

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```
