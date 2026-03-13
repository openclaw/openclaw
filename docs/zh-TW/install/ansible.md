---
summary: >-
  Automated, hardened OpenClaw installation with Ansible, Tailscale VPN, and
  firewall isolation
read_when:
  - You want automated server deployment with security hardening
  - You need firewall-isolated setup with VPN access
  - You're deploying to remote Debian/Ubuntu servers
title: Ansible
---

# Ansible 安裝說明

部署 OpenClaw 至生產伺服器的推薦方式是透過 **[openclaw-ansible](https://github.com/openclaw/openclaw-ansible)** — 一個以安全為優先架構的自動化安裝工具。

## 快速開始

一鍵安裝指令：

```bash
curl -fsSL https://raw.githubusercontent.com/openclaw/openclaw-ansible/main/install.sh | bash
```

> **📦 完整指南：[github.com/openclaw/openclaw-ansible](https://github.com/openclaw/openclaw-ansible)**
>
> openclaw-ansible 倉庫是 Ansible 部署的權威來源。此頁面為快速概覽。

## 你將獲得的功能

- 🔒 **防火牆優先的安全設計**：UFW + Docker 隔離（僅允許 SSH + Tailscale 存取）
- 🔐 **Tailscale VPN**：安全的遠端存取，無需公開服務
- 🐳 **Docker**：隔離的沙盒容器，僅綁定本機端口
- 🛡️ **多層防禦**：四層安全架構
- 🚀 **一鍵部署**：數分鐘內完成完整安裝
- 🔧 **Systemd 整合**：開機自動啟動並強化安全

## 系統需求

- **作業系統**：Debian 11 以上或 Ubuntu 20.04 以上
- **權限**：Root 或 sudo 權限
- **網路**：需連接網際網路以安裝套件
- **Ansible**：2.14 以上（快速開始腳本會自動安裝）

## 安裝內容

Ansible playbook 將安裝並設定：

1. **Tailscale**（Mesh VPN，提供安全遠端存取）
2. **UFW 防火牆**（僅開放 SSH 與 Tailscale 端口）
3. **Docker CE + Compose V2**（用於代理沙盒）
4. **Node.js 24 + pnpm**（執行環境依賴；Node 22 LTS，目前為 `22.16+`，仍維持相容性支援）
5. **OpenClaw**（直接在主機上執行，非容器化）
6. **Systemd 服務**（自動啟動並強化安全）

注意：Gateway 是 **直接在主機上執行**（非 Docker 容器），但代理沙盒則使用 Docker 進行隔離。詳情請參考 [Sandboxing](/gateway/sandboxing)。

## 安裝後設定

安裝完成後，切換到 openclaw 使用者：

```bash
sudo -i -u openclaw
```

安裝後腳本將引導您完成：

1. **新手導覽精靈**：設定 OpenClaw 參數
2. **服務提供者登入**：連接 WhatsApp/Telegram/Discord/Signal
3. **閘道測試**：驗證安裝狀況
4. **Tailscale 設定**：連接您的 VPN 網狀網路

### 快速指令

bash

# 檢查服務狀態

sudo systemctl status openclaw

# 查看即時日誌

sudo journalctl -u openclaw -f

# 重新啟動閘道

sudo systemctl restart openclaw

# 服務提供者登入（以 openclaw 使用者執行）

sudo -i -u openclaw
openclaw channels login

## 安全架構

### 四層防禦

1. **防火牆 (UFW)**：僅公開 SSH (22) 與 Tailscale (41641/udp)
2. **VPN (Tailscale)**：閘道僅能透過 VPN 網狀網路存取
3. **Docker 隔離**：DOCKER-USER iptables 鏈阻擋外部埠口暴露
4. **Systemd 強化**：NoNewPrivileges、PrivateTmp、非特權使用者

### 驗證

測試外部攻擊面：

```bash
nmap -p- YOUR_SERVER_IP
```

應該只顯示 **22 埠**（SSH）開啟。所有其他服務（gateway、Docker）皆已鎖定。

### Docker 可用性

Docker 是為 **agent 沙盒**（隔離工具執行環境）安裝的，而非用來執行 gateway 本身。gateway 僅綁定在 localhost，並可透過 Tailscale VPN 存取。

請參考 [多代理沙盒與工具](/tools/multi-agent-sandbox-tools) 了解沙盒設定。

## 手動安裝

如果你偏好手動控制自動化流程：

bash

# 1. 安裝前置需求

sudo apt update && sudo apt install -y ansible git

# 2. 複製程式庫

git clone https://github.com/openclaw/openclaw-ansible.git
cd openclaw-ansible

# 3. 安裝 Ansible collections

ansible-galaxy collection install -r requirements.yml

# 4. 執行 playbook

./run-playbook.sh

# 或直接執行（之後手動執行 /tmp/openclaw-setup.sh）

# ansible-playbook playbook.yml --ask-become-pass

## 更新 OpenClaw

Ansible 安裝程式會設定 OpenClaw 以供手動更新。標準更新流程請參考 [更新](/install/updating)。

若要重新執行 Ansible playbook（例如修改設定）：

```bash
cd openclaw-ansible
./run-playbook.sh
```

注意：此操作是冪等的，且多次執行皆安全。

## 疑難排解

### 防火牆阻擋我的連線

如果你被鎖住：

- 請先確保你能透過 Tailscale VPN 連線
- SSH 存取（22 埠）始終允許
- 閘道器設計上**僅能**透過 Tailscale 存取

### 服務無法啟動

bash

# 查看日誌

sudo journalctl -u openclaw -n 100

# 驗證權限

sudo ls -la /opt/openclaw

# 測試手動啟動

sudo -i -u openclaw
cd ~/openclaw
pnpm start

### Docker 沙箱問題

bash

# 確認 Docker 是否執行中

sudo systemctl status docker

# 檢查沙箱映像檔

sudo docker images | grep openclaw-sandbox

# 若缺少沙箱映像檔，請建立

cd /opt/openclaw/openclaw
sudo -u openclaw ./scripts/sandbox-setup.sh

### 供應商登入失敗

請確認你是以 `openclaw` 使用者身份執行：

```bash
sudo -i -u openclaw
openclaw channels login
```

## 進階設定

詳細的安全架構與故障排除：

- [安全架構](https://github.com/openclaw/openclaw-ansible/blob/main/docs/security.md)
- [技術細節](https://github.com/openclaw/openclaw-ansible/blob/main/docs/architecture.md)
- [故障排除指南](https://github.com/openclaw/openclaw-ansible/blob/main/docs/troubleshooting.md)

## 相關資源

- [openclaw-ansible](https://github.com/openclaw/openclaw-ansible) — 完整部署指南
- [Docker](/install/docker) — 容器化閘道器設定
- [沙箱機制](/gateway/sandboxing) — 代理程式沙箱設定
- [多代理沙箱與工具](/tools/multi-agent-sandbox-tools) — 針對每個代理的隔離
