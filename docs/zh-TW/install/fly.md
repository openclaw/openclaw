---
title: Fly.io
description: Deploy OpenClaw on Fly.io
summary: Step-by-step Fly.io deployment for OpenClaw with persistent storage and HTTPS
read_when:
  - Deploying OpenClaw on Fly.io
  - "Setting up Fly volumes, secrets, and first-run config"
---

# Fly.io 部署

**目標：** 在 [Fly.io](https://fly.io) 機器上執行 OpenClaw Gateway，具備持久化儲存、自動 HTTPS 以及 Discord/頻道存取功能。

## 你需要準備的專案

- 已安裝 [flyctl CLI](https://fly.io/docs/hands-on/install-flyctl/)
- Fly.io 帳號（免費方案可用）
- 模型授權：你所選模型提供者的 API 金鑰
- 頻道憑證：Discord 機器人 token、Telegram token 等

## 初學者快速路徑

1. 複製倉庫 → 自訂 `fly.toml`
2. 建立應用程式 + 卷 → 設定秘密資訊
3. 使用 `fly deploy` 部署
4. SSH 登入建立設定檔或使用控制介面

## 1) 建立 Fly 應用程式

bash

# 複製倉庫

git clone https://github.com/openclaw/openclaw.git
cd openclaw

# 建立新的 Fly 應用程式（自行命名）

fly apps create my-openclaw

# 建立持久化卷（1GB 通常足夠）

fly volumes create openclaw_data --size 1 --region iad

**小提示：** 選擇離你較近的區域。常見選項：`lhr`（倫敦）、`iad`（維吉尼亞）、`sjc`（聖荷西）。

## 2) 設定 fly.toml

編輯 `fly.toml`，以符合你的應用程式名稱和需求。

**安全提醒：** 預設設定會公開 URL。若要進行無公開 IP 的強化部署，請參考 [私有部署](#private-deployment-hardened) 或使用 `fly.private.toml`。

toml
app = "my-openclaw" # 你的應用程式名稱
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

**主要設定說明：**

| 設定專案                       | 說明                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------- |
| `--bind lan`                   | 綁定到 `0.0.0.0`，讓 Fly 的代理能夠連接到 gateway                             |
| `--allow-unconfigured`         | 無需設定檔即可啟動（你之後會建立設定檔）                                      |
| `internal_port = 3000`         | 必須與 `--port 3000`（或 `OPENCLAW_GATEWAY_PORT`）相符，以通過 Fly 的健康檢查 |
| `memory = "2048mb"`            | 512MB 記憶體太小，建議使用 2GB                                                |
| `OPENCLAW_STATE_DIR = "/data"` | 狀態會持久化到掛載的磁碟區                                                    |

## 3) 設定 secrets

bash

# 必要：Gateway token（用於非 loopback 綁定）

fly secrets set OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32)

# 模型提供者 API 金鑰

fly secrets set ANTHROPIC_API_KEY=sk-ant-...

# 選填：其他提供者

fly secrets set OPENAI_API_KEY=sk-...
fly secrets set GOOGLE_API_KEY=...

# 頻道 token

fly secrets set DISCORD_BOT_TOKEN=MTQ...

**注意事項：**

- 非 loopback 綁定 (`--bind lan`) 需要 `OPENCLAW_GATEWAY_TOKEN` 以確保安全。
- 請將這些 token 視同密碼般保護。
- **建議使用環境變數而非設定檔** 來管理所有 API 金鑰與 token，避免秘密資訊出現在 `openclaw.json` 中，降低意外曝光或被記錄的風險。

## 4) 部署

```bash
fly deploy
```

首次部署會建立 Docker 映像檔（約 2-3 分鐘）。後續部署會更快。

部署完成後，請確認：

```bash
fly status
fly logs
```

你應該會看到：

```
[gateway] listening on ws://0.0.0.0:3000 (PID xxx)
[discord] logged in to discord as xxx
```

## 5) 建立設定檔

使用 SSH 登入機器，建立正確的設定檔：

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

**注意：** 使用 `OPENCLAW_STATE_DIR=/data` 時，設定檔路徑為 `/data/openclaw.json`。

**注意：** Discord token 可以來自：

- 環境變數：`DISCORD_BOT_TOKEN`（建議用於機密資訊）
- 設定檔：`channels.discord.token`

如果使用環境變數，則不需要在設定檔中加入 token。閘道會自動讀取 `DISCORD_BOT_TOKEN`。

重新啟動以套用：

```bash
exit
fly machine restart <machine-id>
```

## 6) 存取閘道

### 控制介面

在瀏覽器中開啟：

```bash
fly open
```

或造訪 `https://my-openclaw.fly.dev/`

貼上您的閘道 token（來自 `OPENCLAW_GATEWAY_TOKEN`）以進行驗證。

### 日誌

```bash
fly logs              # Live logs
fly logs --no-tail    # Recent logs
```

### SSH 主控台

```bash
fly ssh console
```

## 疑難排解

### 「應用程式未監聽預期的位址」

閘道綁定在 `127.0.0.1` 而非 `0.0.0.0`。

**修正方法：** 在 `fly.toml` 的執行指令中加入 `--bind lan`。

### 健康檢查失敗 / 連線被拒

Fly 無法連接到設定的閘道埠口。

**修正方法：** 確認 `internal_port` 與閘道埠口相符（設定 `--port 3000` 或 `OPENCLAW_GATEWAY_PORT=3000`）。

### 記憶體不足 / OOM 問題

容器持續重啟或被終止。徵兆有：`SIGABRT`、`v8::internal::Runtime_AllocateInYoungGeneration`，或無聲重啟。

**修正方法：** 在 `fly.toml` 增加記憶體：

```toml
[[vm]]
  memory = "2048mb"
```

或更新現有機器：

```bash
fly machine update <machine-id> --vm-memory 2048 -y
```

**注意：** 512MB 太小，1GB 可能可用，但在高負載或詳細日誌下仍可能 OOM。**建議使用 2GB。**

### 閘道鎖定問題

閘道啟動時出現「已在執行中」錯誤。

此問題發生於容器重啟，但 PID 鎖定檔仍留存在磁碟卷中。

**修正方法：** 刪除鎖定檔案：

```bash
fly ssh console --command "rm -f /data/gateway.*.lock"
fly machine restart <machine-id>
```

鎖定檔案位於 `/data/gateway.*.lock`（不在子目錄中）。

### 設定檔未被讀取

如果使用 `--allow-unconfigured`，gateway 會建立一個最小化的設定檔。您在 `/data/openclaw.json` 的自訂設定檔應該會在重新啟動時被讀取。

請確認設定檔存在：

```bash
fly ssh console --command "cat /data/openclaw.json"
```

### 透過 SSH 寫入設定檔

`fly ssh console -C` 指令不支援 shell 重導向。要寫入設定檔：

bash

# 使用 echo 搭配 tee（從本地端透過管線傳到遠端）

echo '{"your":"config"}' | fly ssh console -C "tee /data/openclaw.json"

# 或使用 sftp

fly sftp shell

> put /local/path/config.json /data/openclaw.json

**注意：** `fly sftp` 如果檔案已存在可能會失敗。請先刪除：

```bash
fly ssh console --command "rm /data/openclaw.json"
```

### 狀態無法持久化

如果重新啟動後遺失憑證或會話，表示狀態目錄正在寫入容器檔案系統。

**修正：** 確保 `OPENCLAW_STATE_DIR=/data` 已設定於 `fly.toml` 中，並重新部署。

## 更新內容

bash

# 拉取最新變更

git pull

# 重新部署

fly deploy

# 檢查狀態

fly status
fly logs

### 更新機器指令

如果需要更改啟動指令而不進行完整重新部署：

bash

# 取得機器 ID

fly machines list

# 更新指令

fly machine update <machine-id> --command "node dist/index.js gateway --port 3000 --bind lan" -y

# 或同時增加記憶體

fly machine update <machine-id> --vm-memory 2048 --command "node dist/index.js gateway --port 3000 --bind lan" -y

**注意：** 在 `fly deploy` 之後，機器指令可能會重置為 `fly.toml` 中的設定。如果你有手動修改，請在部署後重新套用。

## 私有部署（強化安全）

預設情況下，Fly 會分配公開 IP，使你的 gateway 可透過 `https://your-app.fly.dev` 存取。這雖然方便，但也代表你的部署會被網路掃描器（如 Shodan、Censys 等）發現。

若要進行**無公開暴露**的強化部署，請使用私有範本。

### 何時使用私有部署

- 你只會進行 **外撥** 通話/訊息（不接收 webhook）
- 你使用 **ngrok 或 Tailscale** 隧道來處理任何 webhook 回調
- 你透過 **SSH、代理伺服器或 WireGuard** 存取閘道，而非瀏覽器
- 你希望部署 **對網路掃描器隱藏**

### 設定

請使用 `fly.private.toml` 取代標準設定：

```bash
# Deploy with private config
fly deploy -c fly.private.toml
```

或將現有部署轉換為：

bash

# 列出目前的 IP

fly ips list -a my-openclaw

# 釋放公開 IP

fly ips release <public-ipv4> -a my-openclaw
fly ips release <public-ipv6> -a my-openclaw

# 切換到私有設定，避免未來部署重新分配公開 IP

# （移除 [http_service] 或使用私有範本部署）

fly deploy -c fly.private.toml

# 分配僅限私有的 IPv6

fly ips allocate-v6 --private -a my-openclaw

完成後，`fly ips list` 應該只會顯示 `private` 類型的 IP：

```
VERSION  IP                   TYPE             REGION
v6       fdaa:x:x:x:x::x      private          global
```

### 存取私有部署

由於沒有公開 URL，請使用以下方法之一：

**選項 1：本地代理（最簡單）**

bash

# 將本地 3000 埠轉發到應用程式

fly proxy 3000:3000 -a my-openclaw

# 然後在瀏覽器中開啟 http://localhost:3000

**選項 2：WireGuard VPN**

bash

# 建立 WireGuard 設定檔（一次性）

fly wireguard create

# 匯入到 WireGuard 用戶端，然後透過內部 IPv6 存取

# 範例：http://[fdaa:x:x:x:x::x]:3000

**選項 3：僅限 SSH**

```bash
fly ssh console -a my-openclaw
```

### 私有部署的 Webhooks

如果你需要 webhook 回調（Twilio、Telnyx 等）但不想公開暴露：

1. **ngrok 隧道** - 在容器內或作為 sidecar 執行 ngrok
2. **Tailscale Funnel** - 透過 Tailscale 曝露特定路徑
3. **僅出站** - 某些服務提供者（如 Twilio）在沒有 webhook 的情況下，出站呼叫仍可正常運作

使用 ngrok 的語音通話範例設定：

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

ngrok 隧道在容器內執行，提供公開的 webhook URL，但不會暴露 Fly 應用本身。將 `webhookSecurity.allowedHosts` 設定為公開隧道的主機名稱，以便接受轉發的 host 標頭。

### 安全性優勢

| 專案         | 公開     | 私有     |
| ------------ | -------- | -------- |
| 網路掃描器   | 可被發現 | 隱藏     |
| 直接攻擊     | 可能     | 阻擋     |
| 控制介面存取 | 瀏覽器   | 代理/VPN |
| Webhook 傳送 | 直接     | 透過隧道 |

## 備註

- Fly.io 使用的是 **x86 架構**（非 ARM）
- Dockerfile 相容於兩種架構
- WhatsApp/Telegram 上線時，請使用 `fly ssh console`
- 持久化資料存放於 `/data` 的磁碟區
- Signal 需要 Java + signal-cli；請使用自訂映像檔，並保持記憶體在 2GB 以上。

## 成本

使用推薦設定 (`shared-cpu-2x`，2GB RAM)：

- 約 $10-15 美元/月，視使用量而定
- 免費方案包含部分額度

詳情請參考 [Fly.io 價格說明](https://fly.io/docs/about/pricing/)。
