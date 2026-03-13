---
summary: >-
  Run OpenClaw in a sandboxed macOS VM (local or hosted) when you need isolation
  or iMessage
read_when:
  - You want OpenClaw isolated from your main macOS environment
  - You want iMessage integration (BlueBubbles) in a sandbox
  - You want a resettable macOS environment you can clone
  - You want to compare local vs hosted macOS VM options
title: macOS VMs
---

# macOS VM 上的 OpenClaw（沙盒環境）

## 推薦預設方案（大多數使用者）

- **小型 Linux VPS**，適合持續執行的 Gateway，且成本低廉。詳見 [VPS hosting](/vps)。
- **專用硬體**（Mac mini 或 Linux 主機），如果你想完全掌控並使用 **住宅 IP** 進行瀏覽器自動化。許多網站會封鎖資料中心 IP，因此本地瀏覽通常效果更佳。
- **混合方案**：將 Gateway 放在便宜的 VPS 上，當需要瀏覽器/UI 自動化時，再將你的 Mac 連接為 **節點**。詳見 [Nodes](/nodes) 與 [Gateway remote](/gateway/remote)。

當你特別需要 macOS 專屬功能（如 iMessage/BlueBubbles）或想與日常使用的 Mac 嚴格隔離時，請使用 macOS VM。

## macOS VM 選項

### 在你的 Apple Silicon Mac 上本地 VM（Lume）

使用 [Lume](https://cua.ai/docs/lume) 在你現有的 Apple Silicon Mac 上，於沙盒化的 macOS VM 中執行 OpenClaw。

這能帶給你：

- 完整隔離的 macOS 環境（主機保持乾淨）
- 透過 BlueBubbles 支援 iMessage（Linux/Windows 無法做到）
- 透過複製 VM 即可立即重置
- 無需額外硬體或雲端費用

### 雲端託管的 Mac 服務商

如果你想要雲端的 macOS，託管 Mac 服務商也是可行方案：

- [MacStadium](https://www.macstadium.com/)（託管 Mac）
- 其他託管 Mac 供應商也可使用；請參考他們的 VM + SSH 文件

一旦你取得 macOS VM 的 SSH 存取權限，請從下方第 6 步繼續。

---

## 快速路徑（Lume，進階使用者）

1. 安裝 Lume
2. `lume create openclaw --os macos --ipsw latest`
3. 完成設定助理，啟用遠端登入（SSH）
4. `lume run openclaw --no-display`
5. 使用 SSH 登入，安裝 OpenClaw，設定通道
6. 完成

---

## 您需要的條件（Lume）

- Apple Silicon Mac（M1/M2/M3/M4）
- 主機上需為 macOS Sequoia 或更新版本
- 每台虛擬機約需 60 GB 可用磁碟空間
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

文件： [Lume 安裝指南](https://cua.ai/docs/lume/guide/getting-started/installation)

---

## 2) 建立 macOS 虛擬機

```bash
lume create openclaw --os macos --ipsw latest
```

這會下載 macOS 並建立虛擬機。VNC 視窗會自動開啟。

注意：下載時間會依您的網路連線速度而有所不同。

---

## 3) 完成設定助理

在 VNC 視窗中：

1. 選擇語言和地區
2. 跳過 Apple ID（如果之後想用 iMessage，可以登入）
3. 建立使用者帳號（請記住使用者名稱和密碼）
4. 跳過所有選用功能

設定完成後，啟用 SSH：

1. 開啟「系統設定」→「一般」→「共享」
2. 啟用「遠端登入」

---

## 4) 取得虛擬機的 IP 位址

```bash
lume get openclaw
```

尋找 IP 位址（通常是 `192.168.64.x`）。

---

## 5) SSH 連線到虛擬機

```bash
ssh youruser@192.168.64.X
```

將 `youruser` 替換為您建立的帳號，並將 IP 替換為您的虛擬機器 IP。

---

## 6) 安裝 OpenClaw

在虛擬機器內：

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

依照新手引導提示設定您的模型提供者（Anthropic、OpenAI 等）。

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

接著登入 WhatsApp（掃描 QR 碼）：

```bash
openclaw channels login
```

---

## 8) 以無頭模式執行虛擬機

停止虛擬機並重新啟動，且不顯示畫面：

```bash
lume stop openclaw
lume run openclaw --no-display
```

虛擬機會在背景執行。OpenClaw 的守護程序會持續維持閘道運作。

檢查狀態：

```bash
ssh youruser@192.168.64.X "openclaw status"
```

---

## 額外功能：iMessage 整合

這是 macOS 平台上最強大的功能。使用 [BlueBubbles](https://bluebubbles.app) 將 iMessage 加入 OpenClaw。

在虛擬機內：

1. 從 bluebubbles.app 下載 BlueBubbles
2. 使用你的 Apple ID 登入
3. 啟用 Web API 並設定密碼
4. 將 BlueBubbles 的 webhook 指向你的閘道（範例：`https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`）

加入到你的 OpenClaw 設定檔：

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

重新啟動閘道。現在你的代理程式可以收發 iMessage。

完整設定說明：[BlueBubbles 頻道](/channels/bluebubbles)

---

## 儲存黃金映像

在進一步自訂之前，先快照你的乾淨狀態：

```bash
lume stop openclaw
lume clone openclaw openclaw-golden
```

隨時重置：

```bash
lume stop openclaw && lume delete openclaw
lume clone openclaw-golden openclaw
lume run openclaw --no-display
```

---

## 24/7 持續執行

保持虛擬機持續執行的方法：

- 保持你的 Mac 連接電源
- 在系統設定 → 節能器中關閉睡眠模式
- 如有需要，使用 `caffeinate`

若要真正達成全天候執行，建議使用專用的 Mac mini 或小型 VPS。詳見 [VPS 主機](/vps)。

---

## 疑難排解

| 問題                  | 解決方案                                                        |
| --------------------- | --------------------------------------------------------------- |
| 無法 SSH 連線至虛擬機 | 確認虛擬機系統設定中「遠端登入」已啟用                          |
| 虛擬機 IP 未顯示      | 等待虛擬機完全啟動後，再次執行 `lume get openclaw`              |
| 找不到 Lume 指令      | 將 `~/.local/bin` 加入你的 PATH 環境變數                        |
| WhatsApp QR 無法掃描  | 執行 `openclaw channels login` 時，確保你已登入虛擬機（非主機） |

---

## 相關文件

- [VPS 主機](/vps)
- [節點](/nodes)
- [Gateway 遠端](/gateway/remote)
- [BlueBubbles 頻道](/channels/bluebubbles)
- [Lume 快速入門](https://cua.ai/docs/lume/guide/getting-started/quickstart)
- [Lume CLI 參考](https://cua.ai/docs/lume/reference/cli-reference)
- [無人值守虛擬機設定](https://cua.ai/docs/lume/guide/fundamentals/unattended-setup)（進階）
- [Docker 沙箱環境](/install/docker)（替代隔離方案）
