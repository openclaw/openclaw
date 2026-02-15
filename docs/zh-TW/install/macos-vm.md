---
summary: "在沙箱隔離的 macOS 虛擬機 (本地或託管) 中執行 OpenClaw，以實現隔離或 iMessage 整合"
read_when:
  - 您希望 OpenClaw 與您的主要 macOS 環境隔離
  - 您希望在沙箱中整合 iMessage (BlueBubbles)
  - 您想要一個可重設且可複製的 macOS 環境
  - 您想比較本地與託管 macOS 虛擬機的選項
title: "macOS 虛擬機"
---

# 在 macOS 虛擬機上執行 OpenClaw (沙箱隔離)

## 推薦的預設設定 (大多數使用者)

- **小型 Linux VPS** 提供永遠在線的 Gateway 和低成本。請參閱 [VPS hosting](/vps)。
- 如果您想要完全控制並需要用於瀏覽器自動化的**住宅 IP**，請使用**專用硬體** (Mac mini 或 Linux 主機)。許多網站會封鎖資料中心 IP，因此本地瀏覽通常效果更好。
- **混合模式：** 將 Gateway 放在便宜的 VPS 上，並在需要瀏覽器/UI 自動化時將您的 Mac 作為**節點**連接。請參閱 [Nodes](/nodes) 和 [Gateway remote](/gateway/remote)。

當您特別需要僅限 macOS 的功能 (iMessage/BlueBubbles) 或希望與日常使用的 Mac 嚴格隔離時，請使用 macOS 虛擬機。

## macOS 虛擬機選項

### 在您的 Apple Silicon Mac 上執行本地虛擬機 (Lume)

使用 [Lume](https://cua.ai/docs/lume) 在您現有的 Apple Silicon Mac 上，於沙箱隔離的 macOS 虛擬機中執行 OpenClaw。

這將提供您：

- 隔離的完整 macOS 環境 (您的主機保持乾淨)
- 透過 BlueBubbles 支援 iMessage (在 Linux/Windows 上不可能)
- 透過複製虛擬機實現即時重設
- 無需額外硬體或雲端費用

### 託管 Mac 供應商 (雲端)

如果您需要雲端 macOS，託管 Mac 供應商也能運作：

- [MacStadium](https://www.macstadium.com/) (託管 Mac)
- 其他託管 Mac 供應商也適用；請遵循其虛擬機 + SSH 文件

一旦您擁有 macOS 虛擬機的 SSH 存取權，請繼續執行下面的步驟 6。

---

## 快速路徑 (Lume，經驗豐富的使用者)

1. 安裝 Lume
2. `lume create openclaw --os macos --ipsw latest`
3. 完成「設定輔助程式」，啟用「遠端登入 (SSH)」
4. `lume run openclaw --no-display`
5. SSH 進入，安裝 OpenClaw，設定頻道
6. 完成

---

## 您需要的項目 (Lume)

- Apple Silicon Mac (M1/M2/M3/M4)
- 主機上安裝 macOS Sequoia 或更高版本
- 每個虛擬機約 60 GB 的可用磁碟空間
- 約 20 分鐘

---

## 1) 安裝 Lume

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/lume/scripts/install.sh)"
```

如果 `~/.local/bin` 不在您的 PATH 中：

```bash
echo 'export PATH="$PATH:$HOME/.local/bin"' >> ~/.zshrc && source ~/.zshrc
```

驗證：

```bash
lume --version
```

文件：[Lume 安裝](https://cua.ai/docs/lume/guide/getting-started/installation)

---

## 2) 建立 macOS 虛擬機

```bash
lume create openclaw --os macos --ipsw latest
```

這將下載 macOS 並建立虛擬機。VNC 視窗會自動開啟。

注意：下載時間可能會因您的網路連線而異。

---

## 3) 完成「設定輔助程式」

在 VNC 視窗中：

1. 選擇語言和地區
2. 跳過 Apple ID (如果您稍後需要 iMessage，可選擇登入)
3. 建立使用者帳號 (請記住使用者名稱和密碼)
4. 跳過所有可選功能

設定完成後，啟用 SSH：

1. 開啟「系統設定」→「一般」→「共享」
2. 啟用「遠端登入」

---

## 4) 取得虛擬機的 IP 位址

```bash
lume get openclaw
```

尋找 IP 位址 (通常是 `192.168.64.x`)。

---

## 5) SSH 進入虛擬機

```bash
ssh youruser @192.168.64.X
```

將 `youruser` 替換為您建立的帳號，並將 IP 替換為您的虛擬機 IP。

---

## 6) 安裝 OpenClaw

在虛擬機內部：

```bash
npm install -g openclaw @skills/stock-analysis/cache/hot_scan_latest.json
openclaw onboard --install-daemon
```

依照新手導覽的提示設定您的模型供應商 (Anthropic、OpenAI 等)。

---

## 7) 設定頻道

編輯設定檔：

```bash
nano ~/.openclaw/openclaw.json
```

新增您的頻道：

```json
{
  "channels": {
    "whatsapp": {
      "dmPolicy": "allowlist",
      "allowFrom": ["+15551234567"]
    },
    "telegram": {
      "botToken": "YOUR_BOT_TOKEN"
    }
  }
}
```

然後登入 WhatsApp (掃描 QR 碼)：

```bash
openclaw channels login
```

---

## 8) 無頭模式執行虛擬機

停止虛擬機並在沒有顯示的情況下重新啟動：

```bash
lume stop openclaw
lume run openclaw --no-display
```

虛擬機在背景執行。OpenClaw 的 daemon 會保持 Gateway 運行。

檢查狀態：

```bash
ssh youruser @192.168.64.X "openclaw status"
```

---

## 額外功能：iMessage 整合

這是 macOS 上運行的殺手級功能。使用 [BlueBubbles](https://bluebubbles.app) 將 iMessage 新增到 OpenClaw。

在虛擬機內部：

1. 從 bluebubbles.app 下載 BlueBubbles
2. 使用您的 Apple ID 登入
3. 啟用 Web API 並設定密碼
4. 將 BlueBubbles webhook 指向您的 Gateway (範例: `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`)

新增到您的 OpenClaw 設定：

```json
{
  "channels": {
    "bluebubbles": {
      "serverUrl": "http://localhost:1234",
      "password": "your-api-password",
      "webhookPath": "/bluebubbles-webhook"
    }
  }
}
```

重新啟動 Gateway。現在您的智慧代理可以傳送和接收 iMessage。

完整設定細節：[BlueBubbles 頻道](/channels/bluebubbles)

---

## 儲存黃金映像

在進一步自訂之前，為您的乾淨狀態建立快照：

```bash
lume stop openclaw
lume clone openclaw openclaw-golden
```

隨時重設：

```bash
lume stop openclaw && lume delete openclaw
lume clone openclaw-golden openclaw
lume run openclaw --no-display
```

---

## 24/7 運行

透過以下方式保持虛擬機運行：

- 保持您的 Mac 接上電源
- 在「系統設定」→「省電」中停用睡眠
- 如有需要，使用 `caffeinate`

若要實現真正的永遠在線，請考慮使用專用的 Mac mini 或小型 VPS。請參閱 [VPS hosting
