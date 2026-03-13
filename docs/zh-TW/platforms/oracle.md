---
summary: OpenClaw on Oracle Cloud (Always Free ARM)
read_when:
  - Setting up OpenClaw on Oracle Cloud
  - Looking for low-cost VPS hosting for OpenClaw
  - Want 24/7 OpenClaw on a small server
title: Oracle Cloud
---

# OpenClaw 在 Oracle Cloud (OCI) 上的部署

## 目標

在 Oracle Cloud 的 **Always Free** ARM 等級上執行持續運作的 OpenClaw Gateway。

Oracle 的免費方案非常適合 OpenClaw（尤其是你已經有 OCI 帳號的情況下），但也有一些限制：

- ARM 架構（大部分軟體可用，但部分二進位檔可能只支援 x86）
- 容量有限且註冊過程可能較為繁瑣

## 成本比較（2026）

| 供應商       | 方案            | 規格                  | 月費  | 備註               |
| ------------ | --------------- | --------------------- | ----- | ------------------ |
| Oracle Cloud | Always Free ARM | 最多 4 OCPU，24GB RAM | $0    | ARM 架構，容量有限 |
| Hetzner      | CX22            | 2 vCPU，4GB RAM       | 約 $4 | 最便宜的付費方案   |
| DigitalOcean | Basic           | 1 vCPU，1GB RAM       | $6    | 介面簡單，文件完善 |
| Vultr        | Cloud Compute   | 1 vCPU，1GB RAM       | $6    | 多地點可選         |
| Linode       | Nanode          | 1 vCPU，1GB RAM       | $5    | 現為 Akamai 旗下   |

---

## 前置準備

- Oracle Cloud 帳號（[註冊連結](https://www.oracle.com/cloud/free/)）— 若遇到問題，請參考[社群註冊指南](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd)
- Tailscale 帳號（免費註冊於 [tailscale.com](https://tailscale.com)）
- 約 30 分鐘時間

## 1) 建立 OCI 實例

1. 登入 [Oracle Cloud 控制台](https://cloud.oracle.com/)
2. 前往 **Compute → Instances → Create Instance**
3. 設定：
   - **名稱：** `openclaw`
   - **映像檔：** Ubuntu 24.04 (aarch64)
   - **形態：** `VM.Standard.A1.Flex` (Ampere ARM)
   - **OCPU 數量：** 2（最多可選 4）
   - **記憶體：** 12 GB（最多可選 24 GB）
   - **開機磁碟：** 50 GB（最多可用 200 GB 免費容量）
   - **SSH 金鑰：** 新增你的公鑰
4. 點擊 **Create**
5. 記下公開 IP 位址

**小提示：** 若建立實例時出現「Out of capacity」錯誤，請嘗試切換不同的可用區域或稍後再試。免費方案容量有限。

## 2) 連線並更新系統

bash

# 使用公開 IP 連線

ssh ubuntu@YOUR_PUBLIC_IP

# 更新系統

sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential

**注意：** `build-essential` 是編譯某些 ARM 依賴時所必須的。

## 3) 設定使用者與主機名稱

bash

# 設定主機名稱

sudo hostnamectl set-hostname openclaw

# 設定 ubuntu 使用者密碼

sudo passwd ubuntu

# 啟用 lingering（讓使用者服務在登出後持續執行）

sudo loginctl enable-linger ubuntu

## 4) 安裝 Tailscale

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh --hostname=openclaw
```

這會啟用 Tailscale SSH，讓你可以從 tailnet 上任何裝置透過 `ssh openclaw` 連線 — 不需要公開 IP。

驗證：

```bash
tailscale status
```

**從現在開始，請透過 Tailscale 連線：** `ssh ubuntu@openclaw`（或使用 Tailscale IP）。

## 5) 安裝 OpenClaw

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
source ~/.bashrc
```

當系統詢問「你想如何孵化你的機器人？」時，請選擇 **「稍後再做」**。

> 注意：如果遇到 ARM 原生建置問題，請先從系統套件（例如 `sudo apt install -y build-essential`）著手，而非直接使用 Homebrew。

## 6) 設定 Gateway（loopback + token 認證）並啟用 Tailscale Serve

預設使用 token 認證。這樣較可預測，且避免需要任何「不安全認證」的 Control UI 標誌。

bash

# 保持 Gateway 在 VM 上為私有

openclaw config set gateway.bind loopback

# Gateway 與 Control UI 皆需認證

openclaw config set gateway.auth.mode token
openclaw doctor --generate-gateway-token

# 透過 Tailscale Serve 開放（HTTPS + tailnet 存取）

openclaw config set gateway.tailscale.mode serve
openclaw config set gateway.trustedProxies '["127.0.0.1"]'

systemctl --user restart openclaw-gateway

## 7) 驗證

bash

# 檢查版本

openclaw --version

# 檢查 daemon 狀態

systemctl --user status openclaw-gateway

# 檢查 Tailscale Serve

tailscale serve status

# 測試本地回應

curl http://localhost:18789

## 8) 鎖定 VCN 安全性

既然一切運作正常，請鎖定 VCN，阻擋除 Tailscale 以外的所有流量。OCI 的虛擬雲端網路（Virtual Cloud Network）在網路邊緣充當防火牆 — 流量在抵達您的實例前即被阻擋。

1. 前往 OCI 控制台的 **Networking → Virtual Cloud Networks**
2. 點選您的 VCN → **Security Lists** → 預設安全清單（Default Security List）
3. **移除**所有入口規則，僅保留：
   - `0.0.0.0/0 UDP 41641`（Tailscale）
4. 保留預設的出口規則（允許所有外發）

這會封鎖網路邊緣的 SSH（22 埠）、HTTP、HTTPS 以及所有其他連線。從現在開始，你只能透過 Tailscale 連線。

---

## 存取控制介面

從你 Tailscale 網路上的任何裝置：

```
https://openclaw.<tailnet-name>.ts.net/
```

將 `<tailnet-name>` 替換成你的 tailnet 名稱（可在 `tailscale status` 中看到）。

不需要 SSH 隧道。Tailscale 提供：

- HTTPS 加密（自動憑證）
- 透過 Tailscale 身分驗證
- 從 tailnet 上的任何裝置存取（筆電、手機等）

---

## 安全性：VCN + Tailscale（推薦的基線設定）

當 VCN 被鎖定（只開放 UDP 41641 埠）且 Gateway 綁定在 loopback，能提供強大的深度防禦：公開流量在網路邊緣被封鎖，管理存取則透過你的 tailnet 進行。

這種設定通常不需要額外的主機防火牆規則來阻擋全網際網路的 SSH 暴力破解，但你仍應保持作業系統更新，執行 `openclaw security audit`，並確認沒有意外監聽公開介面。

### 已經受到保護的專案

| 傳統措施          | 是否需要？ | 原因                                                |
| ----------------- | ---------- | --------------------------------------------------- |
| UFW 防火牆        | 不需要     | VCN 在流量到達實例前即封鎖                          |
| fail2ban          | 不需要     | 若 VCN 封鎖 22 埠，則無暴力破解風險                 |
| sshd 強化         | 不需要     | Tailscale SSH 不使用 sshd                           |
| 禁用 root 登入    | 不需要     | Tailscale 使用 Tailscale 身分，而非系統使用者       |
| 僅限 SSH 金鑰認證 | 不需要     | Tailscale 透過你的 tailnet 進行驗證                 |
| IPv6 強化         | 通常不需要 | 視你的 VCN/子網設定而定；請確認實際分配與暴露的狀態 |

### 仍然建議使用

- **憑證權限：** `chmod 700 ~/.openclaw`
- **安全稽核：** `openclaw security audit`
- **系統更新：** 定期 `sudo apt update && sudo apt upgrade`
- **監控 Tailscale：** 在 [Tailscale 管理控制台](https://login.tailscale.com/admin) 檢視裝置

### 驗證安全狀態

bash

# 確認沒有公開埠口在監聽

sudo ss -tlnp | grep -v '127.0.0.1\|::1'

# 驗證 Tailscale SSH 是否啟用

tailscale status | grep -q 'offers: ssh' && echo "Tailscale SSH active"

# 選用：完全停用 sshd

sudo systemctl disable --now ssh

---

## 備援方案：SSH 隧道

如果 Tailscale Serve 無法運作，請使用 SSH 隧道：

```bash
# From your local machine (via Tailscale)
ssh -L 18789:127.0.0.1:18789 ubuntu@openclaw
```

接著開啟 `http://localhost:18789`。

---

## 疑難排解

### 實例建立失敗（「容量不足」）

免費方案的 ARM 實例很搶手。建議嘗試：

- 選擇不同的可用區域
- 在非尖峰時段（清晨）重試
- 選擇形態時使用「Always Free」篩選器

### Tailscale 無法連線

bash

# 檢查狀態

sudo tailscale status

# 重新認證

sudo tailscale up --ssh --hostname=openclaw --reset

### Gateway 無法啟動

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl --user -u openclaw-gateway -n 50
```

### 無法連接 Control UI

bash

# 確認 Tailscale Serve 是否正在執行

tailscale serve status

# 檢查 gateway 是否有監聽

curl http://localhost:18789

# 如有需要，重新啟動

systemctl --user restart openclaw-gateway

### ARM 二進位檔問題

部分工具可能沒有 ARM 版本。請檢查：

```bash
uname -m  # Should show aarch64
```

大多數 npm 套件都能正常運作。至於二進位檔，請尋找 `linux-arm64` 或 `aarch64` 版本釋出。

---

## 持久化

所有狀態皆存放於：

- `~/.openclaw/` — 設定、憑證、會話資料
- `~/.openclaw/workspace/` — 工作區（SOUL.md、記憶體、產物）

請定期備份：

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## 參考資料

- [Gateway 遠端存取](/gateway/remote) — 其他遠端存取模式
- [Tailscale 整合](/gateway/tailscale) — 完整 Tailscale 文件
- [Gateway 設定](/gateway/configuration) — 所有設定選項
- [DigitalOcean 指南](/platforms/digitalocean) — 若想付費且更簡易註冊
- [Hetzner 指南](/install/hetzner) — 基於 Docker 的替代方案
