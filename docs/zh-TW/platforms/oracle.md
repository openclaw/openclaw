---
summary: "在 Oracle Cloud (永遠免費 ARM) 上使用 OpenClaw"
read_when:
  - 在 Oracle Cloud 上設定 OpenClaw
  - 尋找 OpenClaw 的低成本 VPS 託管
  - 希望在小型伺服器上 24/7 運行 OpenClaw
title: "Oracle Cloud"
---

# 在 Oracle Cloud (OCI) 上使用 OpenClaw

## 目標

在 Oracle Cloud 的 **永遠免費** ARM 方案上運行一個持久性的 OpenClaw Gateway。

Oracle 的免費方案非常適合 OpenClaw（尤其是當您已經有 OCI 帳戶時），但它也伴隨著權衡：

- ARM 架構（大多數功能都有效，但某些二進位檔案可能僅限 x86）
- 容量和註冊可能很麻煩

## 成本比較 (2026)

| 供應商     | 方案            | 規格                  | 每月價格 | 備註                 |
| ------------ | --------------- | ---------------------- | -------- | --------------------- |
| Oracle Cloud | Always Free ARM | 高達 4 OCPU, 24GB RAM | $0       | ARM, 有限容量         |
| Hetzner      | CX22            | 2 vCPU, 4GB RAM        | ~ $4     | 最便宜的付費選項      |
| DigitalOcean | Basic           | 1 vCPU, 1GB RAM        | $6       | 易於使用的使用者介面, 優良文件 |
| Vultr        | Cloud Compute   | 1 vCPU, 1GB RAM        | $6       | 許多地點              |
| Linode       | Nanode          | 1 vCPU, 1GB RAM        | $5       | 現為 Akamai 的一部分  |

---

## 先決條件

- Oracle Cloud 帳戶（[註冊](https://www.oracle.com/cloud/free/)）— 如果遇到問題，請參閱[社群註冊指南](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd)
- Tailscale 帳戶（在 [tailscale.com](https://tailscale.com) 免費）
- 約 30 分鐘

## 1) 建立 OCI 實例

1. 登入 [Oracle Cloud Console](https://cloud.oracle.com/)
2. 導航至 **Compute → Instances → Create Instance**
3. 設定：
   - **名稱：** `openclaw`
   - **映像檔：** Ubuntu 24.04 (aarch64)
   - **形狀：** `VM.Standard.A1.Flex` (Ampere ARM)
   - **OCPUs：** 2（或最多 4）
   - **記憶體：** 12 GB（或最多 24 GB）
   - **啟動磁碟區：** 50 GB（最多 200 GB 免費）
   - **SSH 鍵：** 新增您的公開金鑰
4. 點擊 **Create**
5. 記下公開 IP 位址

**提示：** 如果實例建立失敗並顯示「Out of capacity」，請嘗試不同的可用性網域或稍後再試。免費方案的容量有限。

## 2) 連線與更新

```bash
# 透過公開 IP 連線
ssh ubuntu @YOUR_PUBLIC_IP

# 更新系統
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential
```

**備註：** `build-essential` 是 ARM 編譯某些依賴項所必需的。

## 3) 設定使用者和主機名稱

```bash
# 設定主機名稱
sudo hostnamectl set-hostname openclaw

# 設定 ubuntu 使用者的密碼
sudo passwd ubuntu

# 啟用 lingering（登出後保持使用者服務運行）
sudo loginctl enable-linger ubuntu
```

## 4) 安裝 Tailscale

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh --hostname=openclaw
```

這會啟用 Tailscale SSH，因此您可以從 tailnet 上的任何裝置透過 `ssh openclaw` 連線 — 無需公開 IP。

驗證：

```bash
tailscale status
```

**從現在開始，請透過 Tailscale 連線：** `ssh ubuntu @openclaw`（或使用 Tailscale IP）。

## 5) 安裝 OpenClaw

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
source ~/.bashrc
```

當提示「How do you want to hatch your bot?」時，選擇 **「Do this later」**。

> 備註：如果您遇到 ARM 原生建置問題，請先使用系統套件（例如 `sudo apt install -y build-essential`），然後再考慮使用 Homebrew。

## 6) 設定 Gateway (local loopback + 權杖驗證) 並啟用 Tailscale Serve

使用權杖驗證作為預設。它具有可預測性，並避免需要任何「不安全驗證」的 Control UI 旗標。

```bash
# 將 Gateway 保留在 VM 上
openclaw config set gateway.bind loopback

# Gateway + Control UI 需要驗證
openclaw config set gateway.auth.mode token
openclaw doctor --generate-gateway-token

# 透過 Tailscale Serve 暴露（HTTPS + tailnet 存取）
openclaw config set gateway.tailscale.mode serve
openclaw config set gateway.trustedProxies '["127.0.0.1"]'

systemctl --user restart openclaw-gateway
```

## 7) 驗證

```bash
# 檢查版本
openclaw --version

# 檢查守護程式狀態
systemctl --user status openclaw-gateway

# 檢查 Tailscale Serve
tailscale serve status

# 測試本地回應
curl http://localhost:18789
```

## 8) 鎖定 VCN 安全性

現在一切都正常運行了，請鎖定 VCN 以阻擋除 Tailscale 之外的所有流量。OCI 的 Virtual Cloud Network 在網路邊緣充當防火牆 — 流量在到達您的實例之前就被阻擋了。

1. 在 OCI Console 中前往 **Networking → Virtual Cloud Networks**
2. 點擊您的 VCN → **Security Lists** → Default Security List
3. **移除**所有入站規則，除了：
   - `0.0.0.0/0 UDP 41641` (Tailscale)
4. 保留預設的出站規則（允許所有出站）

這會阻擋網路邊緣的連接埠 22 上的 SSH、HTTP、HTTPS 和所有其他內容。從現在開始，您只能透過 Tailscale 連線。

---

## 存取 Control UI

從 Tailscale 網路上的任何裝置：

```
https://openclaw.<tailnet-name>.ts.net/
```

將 `<tailnet-name>` 替換為您的 tailnet 名稱（在 `tailscale status` 中可見）。

無需 SSH 通道。Tailscale 提供：

- HTTPS 加密（自動憑證）
- 透過 Tailscale 身份進行驗證
- 從 tailnet 上的任何裝置（筆記型電腦、手機等）存取

---

## 安全性：VCN + Tailscale（建議的基準）

透過鎖定的 VCN（僅開啟 UDP 41641）和綁定到 local loopback 的 Gateway，您可以獲得強大的深度防禦：公共流量在網路邊緣被阻擋，並且管理員存取透過您的 tailnet 進行。

此設定通常消除了純粹為了阻止全網 SSH 暴力破解而額外設定主機防火牆規則的**需求** — 但您仍應保持作業系統更新，運行 `openclaw security audit`，並驗證您沒有意外地在公共介面上監聽。

### 已受保護的項目

| 傳統步驟       | 需要嗎？ | 原因                                                     |
| ------------------ | -------- | -------------------------------------------------------- |
| UFW 防火牆         | 否       | VCN 在流量到達實例之前就阻擋了                           |
| fail2ban           | 否       | 如果連接埠 22 在 VCN 被阻擋，則沒有暴力破解              |
| sshd 硬化          | 否       | Tailscale SSH 不使用 sshd                                |
| 禁用 root 登入     | 否       | Tailscale 使用 Tailscale 身份，而不是系統使用者          |
| 僅限 SSH 鍵驗證    | 否       | Tailscale 透過您的 tailnet 進行驗證                      |
| IPv6 硬化          | 通常不需要 | 取決於您的 VCN/子網路設定；驗證實際分配/暴露的內容       |

### 仍建議

- **憑證權限：** `chmod 700 ~/.openclaw`
- **安全性稽核：** `openclaw security audit`
- **系統更新：** 定期 `sudo apt update && sudo apt upgrade`
- **監控 Tailscale：** 在 [Tailscale 管理主控台](https://login.tailscale.com/admin) 中審查裝置

### 驗證安全性狀態

```bash
# 確認沒有公共連接埠正在監聽
sudo ss -tlnp | grep -v '127.0.0.1\|::1'

# 驗證 Tailscale SSH 已啟用
tailscale status | grep -q 'offers: ssh' && echo "Tailscale SSH active"

# 可選：完全禁用 sshd
sudo systemctl disable --now ssh
```

---

## 備用：SSH 通道

如果 Tailscale Serve 無法運作，請使用 SSH 通道：

```bash
# 從您的本地機器（透過 Tailscale）
ssh -L 18789:127.0.0.1:18789 ubuntu @openclaw
```

然後打開 `http://localhost:18789`。

---

## 疑難排解

### 實例建立失敗（「Out of capacity」）

免費方案的 ARM 實例很受歡迎。嘗試：

- 不同的可用性網域
- 在非尖峰時段（清晨）重試
- 選擇形狀時使用「Always Free」篩選器

### Tailscale 無法連線

```bash
# 檢查狀態
sudo tailscale status

# 重新驗證
sudo tailscale up --ssh --hostname=openclaw --reset
```

### Gateway 無法啟動

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl --user -u openclaw-gateway -n 50
```

### 無法連接 Control UI

```bash
# 驗證 Tailscale Serve 正在運行
tailscale serve status

# 檢查 Gateway 是否正在監聽
curl http://localhost:18789

# 如有需要，重新啟動
systemctl --user restart openclaw-gateway
```

### ARM 二進位檔案問題

某些工具可能沒有 ARM 建置。檢查：

```bash
uname -m  # 應顯示 aarch64
```

大多數 npm 套件都運行良好。對於二進位檔案，請尋找 `linux-arm64` 或 `aarch64` 版本。

---

## 持續性

所有狀態都儲存在：

- `~/.openclaw/` — 設定、憑證、工作階段資料
- `~/.openclaw/workspace/` — 工作區 (SOUL.md, 記憶體, 產物)

定期備份：

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## 參見

- [Gateway 遠端存取](/gateway/remote) — 其他遠端存取模式
- [Tailscale 整合](/gateway/tailscale) — 完整的 Tailscale 文件
- [Gateway 設定](/gateway/configuration) — 所有設定選項
- [DigitalOcean 指南](/platforms/digitalocean) — 如果您想要付費 + 更輕鬆的註冊
- [Hetzner 指南](/install/hetzner) — 基於 Docker 的替代方案
