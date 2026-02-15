---
summary: "當您需要隔離環境或 iMessage 時，在沙箱隔離的 macOS VM（本地或託管）中執行 OpenClaw"
read_when:
  - 您希望將 OpenClaw 與主要的 macOS 環境隔離
  - 您希望在沙箱中使用 iMessage 整合 (BlueBubbles)
  - 您想要一個可以複製且可重設的 macOS 環境
  - 您想比較本地與託管的 macOS VM 選項
title: "macOS VM"
---

# macOS VM 上的 OpenClaw (沙箱隔離)

## 建議的預設方案（適用於大多數使用者）

- **小型 Linux VPS**：適用於全天候運行的 Gateway 且成本較低。參見 [VPS 託管](/vps)。
- **專用硬體** (Mac mini 或 Linux 主機)：如果您想要完全控制，並需要**住宅 IP** 進行瀏覽器自動化。許多網站會封鎖資料中心 IP，因此本地瀏覽通常效果更好。
- **混合方案**：將 Gateway 放在便宜的 VPS 上，並在需要瀏覽器/UI 自動化時將您的 Mac 作為 **node** 連接。參見 [Nodes](/nodes) 和 [Gateway remote](/gateway/remote)。

當您特別需要 macOS 專屬功能 (iMessage/BlueBubbles) 或希望與日常使用的 Mac 嚴格隔離時，請使用 macOS VM。

## macOS VM 選項

### 本地 Apple Silicon Mac 上的 VM (Lume)

使用 [Lume](https://cua.ai/docs/lume) 在現有的 Apple Silicon Mac 上，於沙箱隔離的 macOS VM 中執行 OpenClaw。

這能帶給您：

- 完全隔離的 macOS 環境（您的主機保持乾淨）
- 透過 BlueBubbles 支援 iMessage（在 Linux/Windows 上無法達成）
- 透過複製 VM 實現即時重設
- 無需額外硬體或雲端成本

### 託管 Mac 供應商 (雲端)

如果您想要雲端上的 macOS，託管 Mac 供應商也適用：

- [MacStadium](https://www.macstadium.com/) (託管 Mac)
- 其他託管 Mac 廠商也適用；請參考他們的 VM + SSH 文件。

一旦您獲得 macOS VM 的 SSH 存取權限，請從下方的第 6 步開始。

---

## 快速路徑 (Lume，資深使用者)

1. 安裝 Lume
2. `lume create openclaw --os macos --ipsw latest`
3. 完成設定助理，啟用遠端登入 (SSH)
4. `lume run openclaw --no-display`
5. 透過 SSH 進入，安裝 OpenClaw，設定頻道
6. 完成

---

## 您需要的準備 (Lume)

- Apple Silicon Mac (M1/M2/M3/M4)
- 主機需安裝 macOS Sequoia 或更新版本
- 每個 VM 約需 60 GB 的可用磁碟空間
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

## 2) 建立 macOS VM

```bash
lume create openclaw --os macos --ipsw latest
```

這會下載 macOS 並建立 VM。VNC 視窗會自動開啟。

注意：下載時間取決於您的網路連線速度。

---

## 3) 完成設定助理

在 VNC 視窗中：

1. 選擇語言和區域
2. 跳過 Apple ID（或者如果您之後想使用 iMessage，則登入）
3. 建立使用者帳號（請記住使用者名稱和密碼）
4. 跳過所有選配功能

設定完成後，啟用 SSH：

1. 開啟「系統設定」→「一般」→「共享」
2. 啟用「遠端登入」

---

## 4) 取得 VM 的 IP 位址

```bash
lume get openclaw
```

尋找 IP 位址（通常是 `192.168.64.x`）。

---

## 5) 透過 SSH 進入 VM

```bash
ssh youruser@192.168.64.X
```

將 `youruser` 替換為您建立的帳號，並將 IP 替換為您 VM 的 IP。

---

## 6) 安裝 OpenClaw

在 VM 內部：

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

按照新手導覽提示來設定您的模型供應商 (Anthropic, OpenAI 等)。

---

## 7) 設定頻道

編輯設定檔案：

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

然後登入 WhatsApp (掃描 QR Code)：

```bash
openclaw channels login
```

---

## 8) 以無介面模式 (Headless) 執行 VM

停止 VM 並在不顯示畫面的情況下重啟：

```bash
lume stop openclaw
lume run openclaw --no-display
```

VM 會在背景執行。OpenClaw 的守護行程 (daemon) 會讓 Gateway 保持運作。

檢查狀態：

```bash
ssh youruser@192.168.64.X "openclaw status"
```

---

## 加碼：iMessage 整合

這是執行於 macOS 的殺手級功能。使用 [BlueBubbles](https://bluebubbles.app) 將 iMessage 新增到 OpenClaw。

在 VM 內部：

1. 從 bluebubbles.app 下載 BlueBubbles
2. 使用您的 Apple ID 登入
3. 啟用 Web API 並設定密碼
4. 將 BlueBubbles webhook 指向您的 Gateway (例如：`https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`)

新增至您的 OpenClaw 設定：

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

重啟 Gateway。現在您的智慧代理即可傳送與接收 iMessage。

完整設定細節：[BlueBubbles 頻道](/channels/bluebubbles)

---

## 儲存黃金映像檔 (Golden Image)

在進行更多自訂之前，請為您的乾淨狀態建立快照：

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

## 全天候執行

透過以下方式保持 VM 運作：

- 讓您的 Mac 接上電源
- 在「系統設定」→「節能器」中停用休眠
- 視需要使用 `caffeinate`

對於真正的全天候運作，請考慮使用專用的 Mac mini 或小型 VPS。參見 [VPS 託管](/vps)。

---

## 疑難排解

| 問題
