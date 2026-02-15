---
summary: "在 Oracle Cloud (Always Free ARM) 上執行 OpenClaw"
read_when:
  - 在 Oracle Cloud 上設定 OpenClaw
  - 尋找低成本的 OpenClaw VPS 代管方案
  - 想在小型伺服器上 24/7 執行 OpenClaw
title: "Oracle Cloud"
---

# 在 Oracle Cloud (OCI) 上執行 OpenClaw

## 目標

在 Oracle Cloud 的 **Always Free** ARM 層級上執行持久的 OpenClaw Gateway。

Oracle 的免費層級非常適合 OpenClaw（特別是如果您已經有 OCI 帳號），但也有一些折衷：

- ARM 架構（大部分功能皆可運作，但某些二進位檔案可能僅支援 x86）
- 容量限制且註冊過程較為繁瑣

## 費用比較 (2026)

| 供應商       | 方案            | 規格                  | 每月價格 | 備註                 |
| ------------ | --------------- | --------------------- | -------- | -------------------- |
| Oracle Cloud | Always Free ARM | 高達 4 OCPU, 24GB RAM | $0       | ARM, 容量有限        |
| Hetzner      | CX22            | 2 vCPU, 4GB RAM       | ~ $4     | 最便宜的付費選項     |
| DigitalOcean | Basic           | 1 vCPU, 1GB RAM       | $6       | 介面友善，文件完善   |
| Vultr        | Cloud Compute   | 1 vCPU, 1GB RAM       | $6       | 節點位置眾多         |
| Linode       | Nanode          | 1 vCPU, 1GB RAM       | $5       | 現為 Akamai 的一部分 |

---

## 先決條件

- Oracle Cloud 帳號（[註冊](https://www.oracle.com/cloud/free/)）— 若遇到問題，請參考 [社群註冊指南](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd)
- Tailscale 帳號（在 [tailscale.com](https://tailscale.com) 免費註冊）
- 約 30 分鐘

## 1) 建立 OCI 執行個體

1. 登入 [Oracle Cloud 主控台](https://cloud.oracle.com/)
2. 導覽至 **Compute → Instances → Create Instance**
3. 設定：
   - **名稱 (Name):** `openclaw`
   - **映像檔 (Image):** Ubuntu 24.04 (aarch64)
   - **資源配置 (Shape):** `VM.Standard.A1.Flex` (Ampere ARM)
   - **OCPUs:** 2 (或最高 4)
   - **記憶體 (Memory):** 12 GB (或最高 24 GB)
   - **開機磁碟卷 (Boot volume):** 50 GB (最高 200 GB 免費)
   - **SSH key:** 新增您的公鑰
4. 按一下 **Create**
5. 記下公用 IP 地址

**提示：** 如果建立執行個體時出現「Out of capacity（容量不足）」，請嘗試不同的可用性網域 (Availability Domain) 或稍後再試。免費層級的容量有限。

## 2) 連線並更新

```bash
# 透過公用 IP 連線
ssh ubuntu@YOUR_PUBLIC_IP

# 更新系統
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential
```

**注意：** `build-essential` 是某些相依項目在 ARM 上編譯時所必需的。

## 3) 設定使用者與主機名稱

```bash
# 設定主機名稱
sudo hostnamectl set-hostname openclaw

# 設定 ubuntu 使用者密碼
sudo passwd ubuntu

# 啟用 lingering (讓使用者服務在登出後繼續執行)
sudo loginctl enable-linger ubuntu
```

## 4) 安裝 Tailscale

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh --hostname=openclaw
```

這會啟用 Tailscale SSH，因此您可以從 tailnet 中的任何裝置透過 `ssh openclaw` 連線，無需公用 IP。

驗證：

```bash
tailscale status
```

**從現在起，請透過 Tailscale 連線：** `ssh ubuntu@openclaw` (或使用 Tailscale IP)。

## 5) 安裝 OpenClaw

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
source ~/.bashrc
```

當系統詢問 "How do you want to hatch your bot?" 時，請選擇 **"Do this later"**。

> 注意：如果您遇到 ARM 原生建置問題，請在嘗試 Homebrew 之前先安裝系統套件（例如 `sudo apt install -y build-essential`）。

## 6) 設定 Gateway (loopback + 權杖驗證) 並啟用 Tailscale Serve

預設使用權杖 (Token) 驗證。這比較可靠，且無需使用任何「不安全驗證」的 Control UI 旗標。

```bash
# 讓 Gateway 在 VM 上保持私有
openclaw config set gateway.bind loopback

# Gateway + Control UI 需要驗證
openclaw config set gateway.auth.mode token
openclaw doctor --generate-gateway-token

# 透過 Tailscale Serve 暴露 (HTTPS + tailnet 存取)
openclaw config set gateway.tailscale.mode serve
openclaw config set gateway.trustedProxies '["127.0.0.1"]'

systemctl --user restart openclaw-gateway
```

## 7) 驗證

```bash
# 檢查版本
openclaw --version

# 檢查精靈程序狀態
systemctl --user status openclaw-gateway

# 檢查 Tailscale Serve
tailscale serve status

# 測試本機回應
curl http://localhost:18789
```

## 8) 鎖定 VCN 安全性

既然一切都已運作正常，請鎖定 VCN 以封鎖除 Tailscale 以外的所有流量。OCI 的虛擬雲端網路 (VCN) 在網路邊緣充當防火牆 — 流量在到達您的執行個體之前就會被封鎖。

1. 前往 OCI 主控台的 **Networking → Virtual Cloud Networks**
2. 點選您的 VCN → **Security Lists** → Default Security List
3. **移除**所有入站規則 (Ingress Rules)，除了：
   - `0.0.0.0/0 UDP 41641` (Tailscale)
4. 保留預設的出站規則 (Allow all outbound)

這會在網路邊緣封鎖連接埠 22 的 SSH、HTTP、HTTPS 及其他所有連線。從現在起，您只能透過 Tailscale 連線。

---

## 存取 Control UI

從 Tailscale 網路中的任何裝置：

```
https://openclaw.<tailnet-name>.ts.net/
```

將 `<tailnet-name>` 替換為您的 tailnet 名稱（可在 `tailscale status` 中查看）。

無需 SSH 通道。Tailscale 提供：

- HTTPS 加密（自動憑證）
- 透過 Tailscale 身分進行驗證
- 從 tailnet 中的任何裝置（筆電、手機等）存取

---

## 安全性：VCN + Tailscale (建議基準)

透過鎖定 VCN（僅開放 UDP 41641）並將 Gateway 綁定到 loopback，您可以獲得強大的縱深防禦：公用流量在網路邊緣被封鎖，而管理存取則透過您的 tailnet 進行。

這種設定通常可以省去為了停止全網 SSH 暴力破解而額外設置主機型防火牆規則的**必要性**，但您
