```
---
summary: "Linux 支援 + 配套應用程式狀態"
read_when:
  - 尋找 Linux 配套應用程式狀態
  - 規劃平台支援或貢獻
title: "Linux 應用程式"
---

# Linux 應用程式

The Gateway 在 Linux 上得到完整支援。**Node 是建議的執行環境**。
不建議 Gateway 使用 Bun (WhatsApp/Telegram 錯誤)。

正在規劃原生的 Linux 配套應用程式。歡迎有意者協助開發。

## 新手快速路徑 (VPS)

1. 安裝 Node 22+
2. `npm i -g openclaw @latest`
3. `openclaw onboard --install-daemon`
4. 從您的筆記型電腦： `ssh -N -L 18789:127.0.0.1:18789 <user> @<host>`
5. 開啟 `http://127.0.0.1:18789/` 並貼上您的 token

逐步 VPS 指南： [exe.dev](/install/exe-dev)

## 安裝

- [入門指南](/start/getting-started)
- [安裝與更新](/install/updating)
- 選用流程： [Bun (實驗性質)](/install/bun)、 [Nix](/install/nix)、 [Docker](/install/docker)

## Gateway

- [Gateway 操作手冊](/gateway)
- [設定](/gateway/configuration)

## Gateway 服務安裝 (CLI)

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

當提示時，選擇 **Gateway service**。

修復/遷移：

```
openclaw doctor
```

## 系統控制 (systemd 使用者單元)

OpenClaw 預設安裝 systemd **使用者**服務。請使用 **系統**
服務，適用於共用或持續運作的伺服器。完整的單元範例和指南
位於 [Gateway 操作手冊](/gateway)。

最簡設定：

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
```
