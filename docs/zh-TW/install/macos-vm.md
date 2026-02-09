---
summary: "在需要隔離或 iMessage 時，於沙箱化的 macOS VM（本機或託管）中執行 OpenClaw"
read_when:
  - 你希望將 OpenClaw 與主要的 macOS 環境隔離
  - 你想在沙箱中使用 iMessage 整合（BlueBubbles）
  - 你需要可重置、可複製的 macOS 環境
  - 你想比較本機與託管的 macOS VM 選項
title: "macOS VM"
---

# 在 macOS VM 上執行 OpenClaw（沙箱隔離）

## 建議的預設（大多數使用者）

- **小型 Linux VPS**：用於全年無休的 Gateway 閘道器，成本低。請參閱 [VPS hosting](/vps)。 See [VPS hosting](/vps).
- **Dedicated hardware** (Mac mini or Linux box) if you want full control and a **residential IP** for browser automation. Many sites block data center IPs, so local browsing often works better.
- **混合式**：將 Gateway 閘道器放在便宜的 VPS 上，當需要瀏覽器／UI 自動化時再連接你的 Mac 作為 **節點**。請參閱 [Nodes](/nodes) 與 [Gateway remote](/gateway/remote)。 See [Nodes](/nodes) and [Gateway remote](/gateway/remote).

當你特別需要僅限 macOS 的能力（iMessage／BlueBubbles），或希望與日常使用的 Mac 嚴格隔離時，才使用 macOS VM。

## macOS VM 選項

### 在 Apple Silicon Mac 上的本機 VM（Lume）

使用 [Lume](https://cua.ai/docs/lume) 在既有的 Apple Silicon Mac 上，以沙箱化的 macOS VM 執行 OpenClaw。

你將獲得：

- 完整且隔離的 macOS 環境（主機保持乾淨）
- 透過 BlueBubbles 支援 iMessage（在 Linux／Windows 上不可能）
- 透過複製 VM 即可立即重置
- 無需額外硬體或雲端成本

### 託管的 Mac 供應商（雲端）

如果你想在雲端使用 macOS，也可以選擇託管的 Mac 供應商：

- [MacStadium](https://www.macstadium.com/)（託管 Mac）
- 其他託管 Mac 供應商亦可；請依其 VM + SSH 文件操作

一旦你取得 macOS VM 的 SSH 存取權，請從下方第 6 步繼續。

---

## 快速路徑（Lume，進階使用者）

1. 安裝 Lume
2. `lume create openclaw --os macos --ipsw latest`
3. 完成設定助理，啟用「遠端登入」（SSH）
4. `lume run openclaw --no-display`
5. 以 SSH 連線、安裝 OpenClaw、設定頻道
6. 完成

---

## 你需要準備的項目（Lume）

- Apple Silicon Mac（M1／M2／M3／M4）
- 主機需為 macOS Sequoia 或更新版本
- 每個 VM 約 60 GB 的可用磁碟空間
- 約 20 分鐘

---

## 1. 安裝 Lume

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/lume/scripts/install.sh)"
```

若 `~/.local/bin` 不在你的 PATH 中：

```bash
echo 'export PATH="$PATH:$HOME/.local/bin"' >> ~/.zshrc && source ~/.zshrc
```

驗證：

```bash
lume --version
```

文件：[Lume Installation](https://cua.ai/docs/lume/guide/getting-started/installation)

---

## 2. 建立 macOS VM

```bash
lume create openclaw --os macos --ipsw latest
```

This downloads macOS and creates the VM. A VNC window opens automatically.

注意：下載時間取決於你的網路連線，可能需要一些時間。

---

## 3. 完成設定助理

在 VNC 視窗中：

1. 選擇語言與地區
2. 略過 Apple ID（或若稍後需要 iMessage 則登入）
3. 建立使用者帳號（請記住使用者名稱與密碼）
4. 略過所有選用功能

完成設定後，啟用 SSH：

1. 開啟「系統設定」→「一般」→「共享」
2. 啟用「遠端登入」

---

## 4. 取得 VM 的 IP 位址

```bash
lume get openclaw
```

尋找 IP 位址（通常為 `192.168.64.x`）。

---

## 5. 以 SSH 連線至 VM

```bash
ssh youruser@192.168.64.X
```

將 `youruser` 替換為你建立的帳號，並將 IP 替換為你的 VM IP。

---

## 6. 安裝 OpenClaw

在 VM 內：

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

依照入門引導提示設定你的模型提供者（Anthropic、OpenAI 等）。

---

## 7. 設定頻道

Edit the config file:

```bash
nano ~/.openclaw/openclaw.json
```

新增你的頻道：

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

接著登入 WhatsApp（掃描 QR）：

```bash
openclaw channels login
```

---

## 8. 以無顯示模式執行 VM

停止 VM，並在不顯示畫面的情況下重新啟動：

```bash
lume stop openclaw
lume run openclaw --no-display
```

The VM runs in the background. OpenClaw's daemon keeps the gateway running.

檢查狀態：

```bash
ssh youruser@192.168.64.X "openclaw status"
```

---

## 加碼：iMessage 整合

This is the killer feature of running on macOS. 這是在 macOS 上執行的關鍵優勢。使用 [BlueBubbles](https://bluebubbles.app) 將 iMessage 加入 OpenClaw。

在 VM 內：

1. 從 bluebubbles.app 下載 BlueBubbles
2. 以你的 Apple ID 登入
3. 啟用 Web API 並設定密碼
4. 將 BlueBubbles webhook 指向你的 Gateway 閘道器（範例：`https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`）

加入至你的 OpenClaw 設定：

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

重新啟動 Gateway 閘道器（或完成入門引導）。 Now your agent can send and receive iMessages.

完整設定細節：[BlueBubbles channel](/channels/bluebubbles)

---

## 儲存黃金映像

在進一步自訂前，先為乾淨狀態建立快照：

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

## Running 24/7

讓 VM 持續運作的方法：

- 讓你的 Mac 持續接上電源
- 在「系統設定」→「節能」中停用睡眠
- 視需要使用 `caffeinate`

若需要真正全年無休，請考慮專用的 Mac mini 或小型 VPS。請參閱 [VPS hosting](/vps)。 See [VPS hosting](/vps).

---

## Troubleshooting

| 問題               | 解決方式                                            |
| ---------------- | ----------------------------------------------- |
| 無法 SSH 連線至 VM    | 確認 VM 的「系統設定」中已啟用「遠端登入」                         |
| 未顯示 VM IP        | 等待 VM 完全開機，再次執行 `lume get openclaw`             |
| 找不到 Lume 指令      | 將 `~/.local/bin` 加入你的 PATH                      |
| WhatsApp QR 無法掃描 | 執行 `openclaw channels login` 時，請確認你登入的是 VM（非主機） |

---

## Related docs

- [VPS hosting](/vps)
- [Nodes](/nodes)
- [Gateway remote](/gateway/remote)
- [BlueBubbles channel](/channels/bluebubbles)
- [Lume Quickstart](https://cua.ai/docs/lume/guide/getting-started/quickstart)
- [Lume CLI Reference](https://cua.ai/docs/lume/reference/cli-reference)
- [Unattended VM Setup](https://cua.ai/docs/lume/guide/fundamentals/unattended-setup)（進階）
- [Docker Sandboxing](/install/docker)（替代的隔離方式）
