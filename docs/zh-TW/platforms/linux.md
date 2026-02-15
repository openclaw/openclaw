---
summary: "Linux 支援 + 配套應用狀態"
read_when:
  - 尋找 Linux 配套應用狀態時
  - 規劃平台覆蓋範圍或貢獻時
title: "Linux 應用程式"
---

# Linux 應用程式

Gateway 在 Linux 上得到完整支援。**Node 是推薦的執行環境**。
Bun 不推薦用於 Gateway（WhatsApp/Telegram 存在錯誤）。

原生 Linux 配套應用已在計劃中。如果您想協助開發，歡迎參與貢獻。

## 初學者快速路徑 (VPS)

1. 安裝 Node 22+
2. `npm i -g openclaw @latest`
3. `openclaw onboard --install-daemon`
4. 在您的筆記型電腦執行：`ssh -N -L 18789:127.0.0.1:18789 <user> @<host>`
5. 開啟 `http://127.0.0.1:18789/` 並貼上您的權杖 (token)

逐步 VPS 指南：[exe.dev](/install/exe-dev)

## 安裝

- [入門指南](/start/getting-started)
- [安裝與更新](/install/updating)
- 選用流程：[Bun (實驗性)](/install/bun), [Nix](/install/nix), [Docker](/install/docker)

## Gateway

- [Gateway 運行指南](/gateway)
- [設定](/gateway/configuration)

## Gateway 服務安裝 (CLI)

使用以下其中一項：

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

出現提示時選擇 **Gateway service**。

修復/遷移：

```
openclaw doctor
```

## 系統控制 (systemd 使用者單元)

OpenClaw 預設安裝 systemd **使用者**服務。對於共用或全天候運行的伺服器，請使用 **系統**服務。完整的單元範例與指南位於 [Gateway 運行指南](/gateway)。

最小化設定：

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
