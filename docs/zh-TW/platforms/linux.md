---
summary: Linux support + companion app status
read_when:
  - Looking for Linux companion app status
  - Planning platform coverage or contributions
title: Linux App
---

# Linux 應用程式

Gateway 完全支援 Linux。**建議使用 Node 作為執行環境**。  
不建議使用 Bun 來執行 Gateway（WhatsApp/Telegram 會有錯誤）。

計畫開發原生 Linux 伴隨應用程式。歡迎有興趣的開發者貢獻協助。

## 初學者快速路徑（VPS）

1. 安裝 Node 24（建議版本；Node 22 LTS，目前 `22.16+`，仍可用於相容性）
2. `npm i -g openclaw@latest`
3. `openclaw onboard --install-daemon`
4. 從你的筆電執行：`ssh -N -L 18789:127.0.0.1:18789 <user>@<host>`
5. 開啟 `http://127.0.0.1:18789/` 並貼上你的 token

VPS 詳細步驟指南：[exe.dev](/install/exe-dev)

## 安裝

- [快速開始](/start/getting-started)
- [安裝與更新](/install/updating)
- 選用流程：[Bun（實驗性）](/install/bun)、[Nix](/install/nix)、[Docker](/install/docker)

## Gateway

- [Gateway 執行手冊](/gateway)
- [設定](/gateway/configuration)

## Gateway 服務安裝（CLI）

請使用以下其中一種方式：

```
openclaw onboard --install-daemon
```

或是：

```
openclaw gateway install
```

或者：

```
openclaw configure
```

當系統提示時，選擇 **Gateway service**。

修復/遷移：

```
openclaw doctor
```

## 系統控制（systemd 使用者單元）

OpenClaw 預設安裝為 systemd **使用者**服務。若是共用或常駐伺服器，請使用 **系統**服務。完整的單元範例與說明請參考 [Gateway runbook](/gateway)。

最小設定：

建立 `~/.config/systemd/user/openclaw-gateway[-<profile>].service`：

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

啟用它：

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```
