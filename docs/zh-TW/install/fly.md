---
title: Fly.io
description: 在 Fly.io 上部署 OpenClaw
---

<!-- markdownlint-disable MD051 -->

# Fly.io 部署

**目標：** 在 [Fly.io](https://fly.io) 機器上執行 OpenClaw Gateway，並具備持久化儲存、自動 HTTPS 以及 Discord/頻道存取權限。

## 您需要準備什麼

- 已安裝 [flyctl CLI](https://fly.io/docs/hands-on/install-flyctl/)
- Fly.io 帳號（免費方案即可）
- 模型認證：Anthropic API 金鑰（或其他供應商金鑰）
- 頻道憑證：Discord 機器人權杖 (token)、Telegram 權杖等。

## 初學者快速路徑

1. 複製儲存庫 → 自訂 `fly.toml`
2. 建立應用程式 + 磁碟卷 (volume) → 設定機密資訊 (secrets)
3. 使用 `fly deploy` 進行部署
4. 透過 SSH 登入建立設定或使用 Control UI

## 1) 建立 Fly 應用程式

```bash
# 複製儲存庫
git clone https://github.com/openclaw/openclaw.git
cd openclaw

# 建立新的 Fly 應用程式（請自行命名）
fly apps create my-openclaw

# 建立持久化磁碟卷 (volume)（通常 1GB 就足夠了）
fly volumes create openclaw_data --size 1 --region iad
```

**提示：** 選擇離您較近的區域。常見選項：`lhr` (倫敦), `iad` (維吉尼亞), `sjc` (聖荷西)。

## 2) 設定 fly.toml

編輯 `fly.toml` 以符合您的應用程式名稱與需求。

**安全注意事項：** 預設設定會公開 URL。若要進行無公網 IP 的加固部署，請參閱[私有部署（加固）](#private-deployment-hardened)或使用 `fly.private.toml`。

```toml
app = "my-openclaw"  # 您的應用程式名稱
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"

[env]
  NODE_ENV = "production"
  OPENCLAW_PREFER_PNPM = "1"
  OPENCLAW_STATE_DIR = "/data"
  NODE_OPTIONS = "--max-old-space-size=1536"

[processes]
  app = "node dist/index.js gateway --allow-unconfigured --port 3000 --bind lan"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = false
  auto_start_machines = true
  min_machines_running = 1
  processes = ["app"]

[[vm]]
  size = "shared-cpu-2x"
  memory = "2048mb"

[mounts]
  source = "openclaw_data"
  destination = "/data"
```

**關鍵設定：**

| 設定                           | 原因                                                                        |
| ------------------------------ | --------------------------------------------------------------------------- |
| `--bind lan`                   | 綁定至 `0.0.0.0`，讓 Fly 的代理伺服器能連接到 Gateway                       |
| `--allow-unconfigured`         | 啟動時不載入設定檔（隨後您將建立一個）                                      |
| `internal_port = 3000`         | 必須與 `--port 3000`（或 `OPENCLAW_GATEWAY_PORT`）一致，以通過 Fly 健康檢查 |
| `memory = "2048mb"`            | 512MB 太小；建議使用 2GB                                                    |
| `OPENCLAW_STATE_DIR = "/data"` | 在磁碟卷上持久化儲存狀態                                                    |

## 3) 設定機密資訊

```bash
# 必要：Gateway 權杖 (token)（用於非 loopback 綁定）
fly secrets set OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32)

# 模型供應商 API 金鑰
fly secrets set ANTHROPIC_API_KEY=sk-ant-...

# 選項：其他供應商
fly secrets set OPENAI_API_KEY=sk-...
fly secrets set GOOGLE_API_KEY=...

# 頻道權杖
fly secrets set DISCORD_BOT_TOKEN=MTQ...
```

**注意事項：**

- 非 loopback 綁定 (`--bind lan`) 出於安全考量需要 `OPENCLAW_GATEWAY_TOKEN`。
- 請將這些權杖視同密碼對待。
- **建議對所有 API 金鑰和權杖使用環境變數而非設定檔**。這能防止機密資訊出現在 `openclaw.json` 中，避免意外洩漏或被記錄在日誌中。

## 4) 部署

```bash
fly deploy
```

首次部署會建置 Docker 映像檔（約需 2-3 分鐘）。之後的部署會更快。

部署完成後，請驗證：

```bash
fly status
fly logs
```

您應該會看到：

```
[gateway] listening on ws://0.0.0.0:3000 (PID xxx)
[discord] logged in to discord as xxx
```

## 5) 建立設定檔

透過 SSH 登入機器以建立正確的設定：

```bash
fly ssh console
```

建立設定目錄與檔案：

```bash
mkdir -p /data
cat > /data/openclaw.json << 'EOF'
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-opus-4-6",
        "fallbacks": ["anthropic/claude-sonnet-4-5", "openai/gpt-4o"]
      },
      "maxConcurrent": 4
    },
    "list": [
      {
        "id": "main",
        "default": true
      }
    ]
  },
  "auth": {
    "profiles": {
      "anthropic:default": { "mode": "token", "provider": "anthropic" },
      "openai:default": { "mode": "token", "provider": "openai" }
    }
  },
  "bindings": [
    {
      "agentId": "main",
      "match": { "channel": "discord" }
    }
  ],
  "channels": {
    "discord": {
      "enabled": true,
      "groupPolicy": "allowlist",
      "guilds": {
        "YOUR_GUILD_ID": {
          "channels": { "general": { "allow": true } },
          "requireMention": false
        }
      }
    }
  },
  "gateway": {
    "mode": "local",
    "bind": "auto"
  },
  "meta": {
    "lastTouchedVersion": "2026.1.29"
  }
}
EOF
```

**注意：** 設定 `OPENCLAW_STATE_DIR=/data` 後，設定檔路徑為 `/data/openclaw.json`。

**注意：** Discord 權杖可以來自以下任一處：

- 環境變數：`DISCORD_BOT_TOKEN`（建議用於存放機密資訊）
- 設定檔：`channels.discord.token`

如果使用環境變數，則無需將權杖加入設定中。Gateway 會自動讀取 `DISCORD_BOT_TOKEN`。

重新啟動以套用設定：

```bash
exit
fly machine restart <machine-id>
```

## 6) 存取 Gateway

### Control UI

在瀏覽器中開啟：

```bash
fly open
```

或造訪 `https://my-openclaw.fly.dev/`

貼上您的 Gateway 權杖（即來自 `OPENCLAW_GATEWAY_TOKEN` 的那個）進行驗證。

### 日誌

```bash
fly logs              # 即時日誌
fly logs --no-tail    # 近期日誌
```

### SSH 終端機

```bash
fly ssh console
```

## 疑難排解

### 「應用程式未監聽預期位址」

Gateway 正綁定到 `127.0.0.1` 而非 `0.0.0.0`。

**修復：** 在 `fly.toml` 的 process 指令中加入 `--bind lan`。

### 健康檢查失敗 / 連線被拒絕

Fly 無法透過設定的連接埠連接到 Gateway。

**修復：** 確保 `internal_port` 與 Gateway 連接埠相符（設定 `--port 3000` 或 `OPENCLAW_GATEWAY_PORT=3000`）。

### OOM / 記憶體問題

容器持續重新啟動或被終止。跡象包括：`SIGABRT`、`v8::internal::Runtime_AllocateInYoungGeneration` 或無聲的重啟。

**修復：** 在 `fly.toml` 中增加記憶體：

```toml
[[vm]]
  memory = "2048mb"
```

或更新現有的機器：

```bash
fly machine update <machine-id> --vm-memory 2048 -y
```

**注意：** 512MB 太小。1GB 可能可行，但在負載下或開啟詳細記錄時可能會發生 OOM。**建議使用 2GB。**

### Gateway 鎖定問題

Gateway 因「已在執行 (already running)」錯誤而拒絕啟動。

這通常發生在容器重啟但 PID 鎖定檔仍殘留在磁碟卷上時。

**修復：** 刪除鎖定檔：

```bash
fly ssh console --command "rm -f /data/gateway.*.lock"
fly machine restart <machine-id>
```

鎖定檔位於 `/data/gateway.*.lock`（不在子目錄中）。

### 設定未被讀取

如果使用 `--allow-unconfigured`，Gateway 會建立一個最簡設定。您位於 `/data/openclaw.json` 的自訂設定應該會在重啟時被讀取。

驗證設定檔是否存在：

```bash
fly ssh console --command "cat /data/openclaw.json"
```

### 透過 SSH 寫入設定

`fly ssh console -C` 指令不支援 shell 重新導向。若要寫入設定檔：

```bash
# 使用 echo + tee（從本地透過管線傳送到遠端）
echo '{"your":"config"}' | fly ssh console -C "tee /data/openclaw.json"

# 或使用 sftp
fly sftp shell
> put /local/path/config.json /data/openclaw.json
```

**注意：** 若檔案已存在，`fly sftp` 可能會失敗。請先刪除：

```bash
fly ssh console --command "rm /data/openclaw.json"
```

### 狀態未持久化

如果您在重啟後遺失憑證或工作階段，說明狀態目錄正寫入容器檔案系統中。

**修復：** 確保 `fly.toml` 中已設定 `OPENCLAW_STATE_DIR=/data` 並重新部署。

## 更新

```bash
# 取得最新變更
git pull

# 重新部署
fly deploy

# 檢查健康狀態
fly status
fly logs
```

### 更新機器指令

如果您需要在不進行完整部署的情況下變更啟動指令：

```bash
# 取得機器 ID
fly machines list

# 更新指令
fly machine update <machine-id> --command "node dist/index.js gateway --port 3000 --bind lan" -y

# 或同時增加記憶體
fly machine update <machine-id> --vm-memory 2048 --command "node dist/index.js gateway --port 3000 --bind lan" -y
```

**注意：** 執行 `fly deploy` 後，機器指令可能會重設為 `fly.toml` 中的內容。如果您進行了手動更改，請在部署後重新套用。

## 私有部署（加固）

預設情況下，Fly 會分配公網 IP，讓您的 Gateway 可以透過 `https://your-app.fly.dev` 存取。這雖然方便，但意味著您的部署會被網路掃描器（如 Shodan、Censys 等）發現。

若要進行**無公網曝露**的加固部署，請使用私有範本。

### 何時使用私有部署

- 您只進行**外發**呼叫/訊息（無傳入的 webhook）
- 您對任何 webhook 回呼使用 **ngrok 或 Tailscale** 通道
- 您透過 **SSH、代理或 WireGuard** 而非瀏覽器存取 Gateway
- 您希望部署**對網路掃描器隱藏**

### 設定

使用 `fly.private.toml` 而非標準設定：

```bash
# 使用私有設定進行部署
fly deploy -c fly.private.toml
```

或轉換現有的部署：

```bash
# 列出目前的 IP
fly ips list -a my-openclaw

# 釋放公網 IP
fly ips release <public-ipv4> -a my-openclaw
fly ips release <public-ipv6> -a my-openclaw

# 切換到私有設定，以免未來的部署重新分配公網 IP
# （移除 [http_service] 或使用私有範本進行部署）
fly deploy -c fly.private.toml

# 分配僅限私有的 IPv6
fly ips allocate-v6 --private -a my-openclaw
```

在此之後，`fly ips list` 應該只會顯示 `private` 類型的 IP：

```
VERSION  IP                   TYPE             REGION
v6       fdaa:x:x:x:x::x      private          global
```

### 存取私有部署

由於沒有公網 URL，請使用以下方法之一：

**選項 1：本地代理（最簡單）**

```bash
# 將本地連接埠 3000 轉發至應用程式
fly proxy 3000:3000 -a my-openclaw

# 然後在瀏覽器中開啟 http://localhost:3000
```

**選項 2：WireGuard VPN**

```bash
# 建立 WireGuard 設定（僅需一次）
fly wireguard create

# 匯入 WireGuard 客戶端，然後透過內部 IPv6 存取
# 例如：http://[fdaa:x:x:x:x::x]:3000
```

**選項 3：僅限 SSH**

```bash
fly ssh console -a my-openclaw
```

### 私有部署下的 Webhook

如果您在不公開曝露的情況下需要 webhook 回呼（如 Twilio、Telnyx 等）：

1. **ngrok 通道** - 在容器內或以 sidecar 方式執行 ngrok
2. **Tailscale Funnel** - 透過 Tailscale 公開特定路徑
3. **僅限外發** - 某些供應商（如 Twilio）在沒有 webhook 的情況下也能正常進行外發呼叫

搭配 ngrok 的 voice-call 設定範例：

```json
{
  "plugins": {
    "entries": {
      "voice-call": {
        "enabled": true,
        "config": {
          "provider": "twilio",
          "tunnel": { "provider": "ngrok" },
          "webhookSecurity": {
            "allowedHosts": ["example.ngrok.app"]
          }
        }
      }
    }
  }
}
```

ngrok 通道在容器內執行，並提供公網 webhook URL，而不會曝露 Fly 應用程式本身。請將 `webhookSecurity.allowedHosts` 設定為公網通道的主機名稱，以便接受轉發的主機標頭。

### 安全性優勢

| 面向            | 公用   | 私有     |
| --------------- | ------ | -------- |
| 網路掃描器      | 可發現 | 隱藏     |
| 直接攻擊        | 可能   | 被封鎖   |
| Control UI 存取 | 瀏覽器 | 代理/VPN |
| Webhook 遞送    | 直接   | 透過通道 |

## 備註

- Fly.io 使用 **x86 架構**（而非 ARM）
- Dockerfile 與兩種架構皆相容
- 對於 WhatsApp/Telegram 的新手導覽，請使用 `fly ssh console`
- 持久化資料儲存在位於 `/data` 的磁碟卷上
- Signal 需要 Java + signal-cli；請使用自訂映像檔並保持記憶體在 2GB 以上。

## 費用

使用建議設定 (`shared-cpu-2x`, 2GB RAM)：

- 每月約 $10-15 美元，視使用量而定
- 免費方案包含部分額度

詳情請參閱 [Fly.io 定價](https://fly.io/docs/about/pricing/)。
