---
summary: "使用 Ansible、Tailscale VPN 和防火牆隔離的自動化、強化 OpenClaw 安裝"
read_when:
  - 您需要自動化伺服器部署並強化安全性
  - 您需要防火牆隔離設定並具備 VPN 存取
  - 您正在部署至遠端 Debian/Ubuntu 伺服器
title: "Ansible"
---

# Ansible 安裝

將 OpenClaw 部署到生產伺服器的建議方式是透過 **[openclaw-ansible](https://github.com/openclaw/openclaw-ansible)** — 這是一個具備安全優先架構的自動化安裝程式。

## 快速開始

一鍵安裝：

```bash
curl -fsSL https://raw.githubusercontent.com/openclaw/openclaw-ansible/main/install.sh | bash
```

> **📦 了解詳情: [github.com/openclaw/openclaw-ansible](https://github.com/openclaw/openclaw-ansible)**
>
> openclaw-ansible 儲存庫是 Ansible 部署的真實來源。本頁提供快速概覽。

## 您會獲得什麼

- 🔒 **防火牆優先的安全性**: UFW + Docker 隔離（僅 SSH + Tailscale 可存取）
- 🔐 **Tailscale VPN**: 安全的遠端存取，無需公開服務
- 🐳 **Docker**: 隔離的沙箱容器，僅限 localhost 綁定
- 🛡️ **縱深防禦**: 4 層安全架構
- 🚀 **一鍵設定**: 數分鐘內完成部署
- 🔧 **Systemd 整合**: 開機時自動啟動並強化

## 需求

- **作業系統**: Debian 11+ 或 Ubuntu 20.04+
- **存取權限**: Root 或 sudo 權限
- **網路**: 安裝套件所需的網際網路連線
- **Ansible**: 2.14+ (由快速開始指令碼自動安裝)

## 安裝內容

Ansible 劇本會安裝並設定：

1. **Tailscale** (用於安全遠端存取的網狀 VPN)
2. **UFW 防火牆** (僅限 SSH + Tailscale 連接埠)
3. **Docker CE + Compose V2** (用於智慧代理沙箱)
4. **Node.js 22.x + pnpm** (執行階段相依性)
5. **OpenClaw** (基於主機，非容器化)
6. **Systemd 服務** (開機自動啟動並強化安全性)

注意: Gateway **直接在主機上** 執行 (不在 Docker 中)，但智慧代理沙箱使用 Docker 進行隔離。請參閱 [沙箱隔離](/gateway/sandboxing) 了解詳情。

## 安裝後設定

安裝完成後，切換到 openclaw 使用者：

```bash
sudo -i -u openclaw
```

安裝後指令碼將引導您完成：

1. **新手導覽精靈**: 設定 OpenClaw 設定
2. **供應商登入**: 連線 WhatsApp/Telegram/Discord/Signal
3. **Gateway 測試**: 驗證安裝
4. **Tailscale 設定**: 連線到您的 VPN 網狀網路

### 快速指令

```bash
# Check service status
sudo systemctl status openclaw

# View live logs
sudo journalctl -u openclaw -f

# Restart gateway
sudo systemctl restart openclaw

# Provider login (run as openclaw user)
sudo -i -u openclaw
openclaw channels login
```

## 安全架構

### 4 層防禦

1. **防火牆 (UFW)**: 僅限 SSH (22) + Tailscale (41641/udp) 公開暴露
2. **VPN (Tailscale)**: Gateway 僅可透過 VPN 網狀網路存取
3. **Docker 隔離**: DOCKER-USER iptables 鏈可防止外部連接埠暴露
4. **Systemd 強化**: NoNewPrivileges, PrivateTmp, 非特權使用者

### 驗證

測試外部攻擊面：

```bash
nmap -p- YOUR_SERVER_IP
```

應顯示**僅連接埠 22** (SSH) 開啟。所有其他服務 (Gateway, Docker) 均已鎖定。

### Docker 可用性

安裝 Docker 是為了**智慧代理沙箱** (隔離的工具執行)，而不是為了執行 Gateway 本身。Gateway 僅綁定到 localhost，並可透過 Tailscale VPN 存取。

請參閱 [多智慧代理沙箱與工具](/tools/multi-agent-sandbox-tools) 了解沙箱設定。

## 手動安裝

如果您偏好手動控制自動化：

```bash
# 1. Install prerequisites
sudo apt update && sudo apt install -y ansible git

# 2. Clone repository
git clone https://github.com/openclaw/openclaw-ansible.git
cd openclaw-ansible

# 3. Install Ansible collections
ansible-galaxy collection install -r requirements.yml

# 4. Run playbook
./run-playbook.sh

# Or run directly (then manually execute /tmp/openclaw-setup.sh after)
# ansible-playbook playbook.yml --ask-become-pass
```

## 更新 OpenClaw

Ansible 安裝程式會設定 OpenClaw 以進行手動更新。請參閱 [更新](/install/updating) 了解標準更新流程。

若要重新執行 Ansible 劇本 (例如，用於設定變更)：

```bash
cd openclaw-ansible
./run-playbook.sh
```

注意: 這是冪等的，可以安全地執行多次。

## 疑難排解

### 防火牆阻擋我的連線

如果您被鎖定在外部：

- 首先確保您可以透過 Tailscale VPN 存取
- 永遠允許 SSH 存取 (連接埠 22)
- Gateway 根據設計**僅**能透過 Tailscale 存取

### 服務無法啟動

```bash
# Check logs
sudo journalctl -u openclaw -n 100

# Verify permissions
sudo ls -la /opt/openclaw

# Test manual start
sudo -i -u openclaw
cd ~/openclaw
pnpm start
```

### Docker 沙箱問題

```bash
# Verify Docker is running
sudo systemctl status docker

# Check sandbox image
sudo docker images | grep openclaw-sandbox

# Build sandbox image if missing
cd /opt/openclaw/openclaw
sudo -u openclaw ./scripts/sandbox-setup.sh
```

### 供應商登入失敗

確保您以 `openclaw` 使用者身分執行：

```bash
sudo -i -u openclaw
openclaw channels login
```

## 進階設定

有關詳細的安全架構和疑難排解：

- [安全架構](https://github.com/openclaw/openclaw-ansible/blob/main/docs/security.md)
- [技術細節](https://github.com/openclaw/openclaw-ansible/blob/main/docs/architecture.md)
- [疑難排解指南](https://github.com/openclaw/openclaw-ansible/blob/main/docs/troubleshooting.md)

## 相關資訊

- [openclaw-ansible](https://github.com/openclaw/openclaw-ansible) — 完整部署指南
- [Docker](/install/docker) — 容器化 Gateway 設定
- [沙箱隔離](/gateway/sandboxing) — 智慧代理沙箱設定
- [多智慧代理沙箱與工具](/tools/multi-agent-sandbox-tools) — 每智慧代理隔離
