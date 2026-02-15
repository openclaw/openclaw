---
summary: "使用 Ansible、Tailscale VPN 和防火牆隔離進行自動化、強化的 OpenClaw 安裝"
read_when:
  - 您想要具備安全強化的自動化伺服器部署
  - 您需要具備 VPN 存取的防火牆隔離設定
  - 您正在部署到遠端 Debian/Ubuntu 伺服器
title: "Ansible"
---

# Ansible 安裝

將 OpenClaw 部署到生產伺服器的推薦方式是透過 **[openclaw-ansible](https://github.com/openclaw/openclaw-ansible)** — 這是一個採用安全優先架構的自動化安裝程式。

## 快速開始

一鍵安裝：

```bash
curl -fsSL https://raw.githubusercontent.com/openclaw/openclaw-ansible/main/install.sh | bash
```

> **📦 完整指南：[github.com/openclaw/openclaw-ansible](https://github.com/openclaw/openclaw-ansible)**
>
> openclaw-ansible 儲存庫是 Ansible 部署的權威來源。本頁面僅為快速概覽。

## 您將獲得

- 🔒 **防火牆優先安全性**：UFW + Docker 隔離（僅可存取 SSH + Tailscale）
- 🔐 **Tailscale VPN**：安全的遠端存取，無需將服務公開暴露
- 🐳 **Docker**：隔離的沙箱容器，僅繫結至 localhost
- 🛡️ **縱深防禦**：4 層安全架構
- 🚀 **一鍵設定**：幾分鐘內完成完整部署
- 🔧 **Systemd 整合**：開機自動啟動並具備安全強化

## 需求

- **作業系統**：Debian 11+ 或 Ubuntu 20.04+
- **權限**：Root 或 sudo 權限
- **網路**：安裝套件所需的網際網路連線
- **Ansible**：2.14+（由快速開始指令碼自動安裝）

## 安裝內容

Ansible playbook 會安裝並設定：

1. **Tailscale**（用於安全遠端存取的網格 VPN）
2. **UFW 防火牆**（僅開放 SSH + Tailscale 連接埠）
3. **Docker CE + Compose V2**（用於智慧代理沙箱）
4. **Node.js 22.x + pnpm**（執行階段依賴項目）
5. **OpenClaw**（主機型部署，非容器化）
6. **Systemd 服務**（具備安全強化的自動啟動）

注意：Gateway **直接在主機上**執行（而非在 Docker 中），但智慧代理沙箱使用 Docker 進行隔離。詳請參閱 [沙箱隔離](/gateway/sandboxing)。

## 安裝後設定

安裝完成後，切換到 openclaw 使用者：

```bash
sudo -i -u openclaw
```

安裝後指令碼將引導您完成：

1. **新手導覽精靈**：設定 OpenClaw 設定
2. **供應商登入**：連接 WhatsApp/Telegram/Discord/Signal
3. **Gateway 測試**：驗證安裝
4. **Tailscale 設定**：連接到您的 VPN 網格

### 常用指令

```bash
# 檢查服務狀態
sudo systemctl status openclaw

# 查看即時記錄
sudo journalctl -u openclaw -f

# 重新啟動 Gateway
sudo systemctl restart openclaw

# 供應商登入（以 openclaw 使用者執行）
sudo -i -u openclaw
openclaw channels login
```

## 安全架構

### 4 層防禦

1. **防火牆 (UFW)**：僅對外公開 SSH (22) + Tailscale (41641/udp)
2. **VPN (Tailscale)**：僅能透過 VPN 網格存取 Gateway
3. **Docker 隔離**：DOCKER-USER iptables 鏈防止外部連接埠暴露
4. **Systemd 強化**：NoNewPrivileges、PrivateTmp、非特權使用者

### 驗證

測試外部攻擊面：

```bash
nmap -p- YOUR_SERVER_IP
```

應僅顯示 **port 22** (SSH) 為開啟狀態。所有其他服務 (Gateway, Docker) 皆已鎖定。

### Docker 可用性

安裝 Docker 是為了 **智慧代理沙箱**（隔離的工具執行），而非為了執行 Gateway 本身。Gateway 僅繫結至 localhost 並透過 Tailscale VPN 存取。

請參閱 [多智慧代理沙箱與工具](/tools/multi-agent-sandbox-tools) 以了解沙箱設定。

## 手動安裝

如果您偏好手動控制自動化流程：

```bash
# 1. 安裝必要條件
sudo apt update && sudo apt install -y ansible git

# 2. 複製儲存庫
git clone https://github.com/openclaw/openclaw-ansible.git
cd openclaw-ansible

# 3. 安裝 Ansible collections
ansible-galaxy collection install -r requirements.yml

# 4. 執行 playbook
./run-playbook.sh

# 或直接執行（之後需手動執行 /tmp/openclaw-setup.sh）
# ansible-playbook playbook.yml --ask-become-pass
```

## 更新 OpenClaw

Ansible 安裝程式將 OpenClaw 設定為手動更新。請參閱 [更新](/install/updating) 以了解標準更新流程。

若要重新執行 Ansible playbook（例如為了更改設定）：

```bash
cd openclaw-ansible
./run-playbook.sh
```

注意：此操作具有冪等性，多次執行是安全的。

## 疑難排解

### 防火牆封鎖了我的連線

如果您被鎖在外面：

- 請確保優先透過 Tailscale VPN 存取
- SSH 存取 (port 22) 始終是允許的
- 根據設計，Gateway **只能**透過 Tailscale 存取

### 服務無法啟動

```bash
# 檢查記錄
sudo journalctl -u openclaw -n 100

# 驗證權限
sudo ls -la /opt/openclaw

# 測試手動啟動
sudo -i -u openclaw
cd ~/openclaw
pnpm start
```

### Docker 沙箱問題

```bash
# 驗證 Docker 是否正在執行
sudo systemctl status docker

# 檢查沙箱映像檔
sudo docker images | grep openclaw-sandbox

# 如果遺失則建置沙箱映像檔
cd /opt/openclaw/openclaw
sudo -u openclaw ./scripts/sandbox-setup.sh
```

### 供應商登入失敗

請確保您是以 `openclaw` 使用者身份執行：

```bash
sudo -i -u openclaw
openclaw channels login
```

## 進階設定

如需詳細的安全架構與疑難排解：

- [安全架構](https://github.com/openclaw/openclaw-ansible/blob/main/docs/security.md)
- [技術細節](https://github.com/openclaw/openclaw-ansible/blob/main/docs/architecture.md)
- [疑難排解指南](https://github.com/openclaw/openclaw-ansible/blob/main/docs/troubleshooting.md)

## 相關連結

- [openclaw-ansible](https://github.com/openclaw/openclaw-ansible) — 完整部署指南
- [Docker](/install/docker) — 容器化 Gateway 設定
- [沙箱隔離](/gateway/sandboxing) — 智慧代理沙箱設定
- [多智慧代理沙箱與工具](/tools/multi-agent-sandbox-tools) — 智慧代理獨立隔離
