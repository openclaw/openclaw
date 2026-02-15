---
title: Fly.io
description: 在 Fly.io 上部署 OpenClaw
---

# Fly.io 部署

**目標：** OpenClaw Gateway 在 [Fly.io](https://fly.io) 機器上運行，具備永久儲存、自動 HTTPS 以及 Discord/頻道存取。

## 您需要準備

-   已安裝 [flyctl CLI](https://fly.io/docs/hands-on/install-flyctl/)
-   Fly.io 帳號 (免費方案即可)
-   模型憑證：Anthropic API 金鑰 (或其他供應商金鑰)
-   頻道憑證：Discord bot 權杖、Telegram 權杖等。

## 初學者快速開始

1.  複製儲存庫 → 自訂 `fly.toml`
2.  建立應用程式 + 磁碟區 → 設定密鑰
3.  使用 `fly deploy` 進行部署
4.  透過 SSH 進入建立設定或使用 Control UI

## 1) 建立 Fly 應用程式

```bash
# Clone the repo
git clone https://github.com/openclaw/openclaw.git
cd openclaw

# Create a new Fly app (pick your own name)
fly apps create my-openclaw

# Create a persistent volume (1GB is usually enough)
fly volumes create openclaw_data --size 1 --region iad
```

**提示：** 選擇離您近的區域。常見選項有：`lhr` (倫敦)、`iad` (維吉尼亞)、`sjc` (聖荷西)。

## 2) 設定 fly.toml

編輯 `fly.toml` 以符合您的應用程式名稱和需求。

**安全注意事項：** 預設設定會暴露公共 URL。若要進行無公共 IP 的強化部署，請參閱 [私有部署](#private-deployment-hardened) 或使用 `fly.private.toml`。

```toml
app = "my-openclaw"  # Your app name
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

**重要設定：**

| 設定                        | 原因                                                                    |
| :-------------------------- | :---------------------------------------------------------------------- |
| `--bind lan`                | 綁定到 `0.0.0.0`，以便 Fly 的代理可以觸及 Gateway                       |
| `--allow-unconfigured`      | 在沒有設定檔案的情況下啟動 (您稍後會建立一個)                             |
| `internal_port = 3000`      | 必須符合 `--port 3000` (或 `OPENCLAW_GATEWAY_PORT`) 以進行 Fly 健康檢查 |
| `memory = "2048mb"`         | 512MB 太小；建議 2GB                                                    |
| `OPENCLAW_STATE_DIR = "/data"` | 將狀態持久化到磁碟區                                                    |

## 3) 設定密鑰

```bash
# Required: Gateway token (for non-loopback binding)
fly secrets set OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32)

# Model provider API keys
fly secrets set ANTHROPIC_API_KEY=sk-ant-...

# Optional: Other providers
fly secrets set OPENAI_API_KEY=sk-...
fly secrets set GOOGLE_API_KEY=...

# Channel tokens
fly secrets set DISCORD_BOT_TOKEN=MTQ...
```

**注意事項：**

-   非 local loopback 綁定 (`--bind lan`) 需要 `OPENCLAW_GATEWAY_TOKEN` 以確保安全。
-   請像對待密碼一樣對待這些權杖。
-   所有 API 金鑰和權杖 **優先使用環境變數而非設定檔案**。這可以避免密鑰暴露或被記錄在 `openclaw.json` 中。

## 4) 部署

```bash
fly deploy
```

首次部署會建置 Docker 映像檔 (約 2-3 分鐘)。後續部署會更快。

部署後，驗證：

```bash
fly status
fly logs
```

您應該會看到：

```
[gateway] listening on ws://0.0.0.0:3000 (PID xxx)
[discord] logged in to discord as xxx
```

## 5) 建立設定檔案

SSH 進入機器以建立正確的設定：

```bash
fly ssh console
```

建立設定目錄和檔案：

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

**注意事項：** 由於 `OPENCLAW_STATE_DIR=/data`，設定路徑為 `/data/openclaw.json`。

**注意事項：** Discord 權杖可以來自：

-   環境變數：`DISCORD_BOT_TOKEN` (建議用於密鑰)
-   設定檔案：`channels.discord.token`

如果使用環境變數，則無需將權杖加入設定中。Gateway 會自動讀取 `DISCORD_BOT_TOKEN`。

重新啟動以套用：

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

貼上您的 gateway 權杖 (來自 `OPENCLAW_GATEWAY_TOKEN`) 以進行身分驗證。

### 記錄

```bash
fly logs              # 即時記錄
fly logs --no-tail    # 近期記錄
```

### SSH 主控台

```bash
fly ssh console
```

## 疑難排解

### 「App is not listening on expected address」(應用程式未在預期位址上監聽)

Gateway 綁定到 `127.0.0.1` 而不是 `0.0.0.0`。

**修正：** 在 `fly.toml` 中的程序指令中加入 `--bind lan`。

### 健康檢查失敗 / 連線被拒

Fly 無法透過設定的連接埠連接到 Gateway。

**修正：** 確保 `internal_port` 與 Gateway 連接埠相符 (設定 `--port 3000` 或 `OPENCLAW_GATEWAY_PORT=3000`)。

### OOM / 記憶體問題

容器持續重新啟動或被終止。跡象：`SIGABRT`、`v8::internal::Runtime_AllocateInYoungGeneration` 或無聲重新啟動。

**修正：** 增加 `fly.toml` 中的記憶體：

```toml
[[vm]]
  memory = "2048mb"
```

或更新現有機器：

```bash
fly machine update <machine-id> --vm-memory 2048 -y
```

**注意事項：** 512MB 太小。1GB 可能可以運作，但在負載過重或日誌冗長時可能會 OOM。**建議使用 2GB。**

### Gateway 鎖定問題

Gateway 拒絕啟動並顯示「already running」錯誤。

這會在容器重新啟動但 PID 鎖定檔案仍存在於磁碟區上時發生。

**修正：** 刪除鎖定檔案：

```bash
fly ssh console --command "rm -f /data/gateway.*.lock"
fly machine restart <machine-id>
```

鎖定檔案位於 `/data/gateway.*.lock` (不在子目錄中)。

### 設定未被讀取

如果使用 `--allow-unconfigured`，Gateway 會建立一個最小設定。您的自訂設定 `/data/openclaw.json` 應該在重新啟動時被讀取。

驗證設定是否存在：

```bash
fly ssh console --command "cat /data/openclaw.json"
```

### 透過 SSH 寫入設定

`fly ssh console -C` 指令不支援 shell 重定向。若要寫入設定檔案：

```bash
# 使用 echo + tee (從本地透過管道傳輸到遠端)
echo '{"your":"config"}' | fly ssh console -C "tee /data/openclaw.openclaw.json"

# 或使用 sftp
fly sftp shell
> put /local/path/config.json /data/openclaw.openclaw.json
```

**注意事項：** 如果檔案已存在，`fly sftp` 可能會失敗。請先刪除：

```bash
fly ssh console --command "rm /data/openclaw.openclaw.json"
```

### 狀態未持續儲存

如果您在重新啟動後失去憑證或工作階段，則狀態目錄正在寫入容器檔案系統。

**修正：** 確保 `fly.toml` 中設定了 `OPENCLAW_STATE_DIR=/data` 並重新部署。

## 更新

```bash
# 拉取最新變更
git pull

# 重新部署
fly deploy

# 檢查健康狀態
fly status
fly logs
```

### 更新機器指令

如果您需要更改啟動指令而無需完全重新部署：

```bash
# 取得機器 ID
fly machines list

# 更新指令
fly machine update <machine-id> --command "node dist/index.js gateway --port 3000 --bind lan" -y

# 或增加記憶體
fly machine update <machine-id> --vm-memory 2048 --command "node dist/index.js gateway --port 3000 --bind lan" -y
```

**注意事項：** 在 `fly deploy` 之後，機器指令可能會重設為 `fly.toml` 中的內容。如果您進行了手動更改，請在部署後重新套用。

## 私有部署 (強化)

預設情況下，Fly 會分配公共 IP，使您的 Gateway 可透過 `https://your-app.fly.dev` 存取。這很方便，但意味著您的部署可能被網路掃描器 (Shodan, Censys 等) 發現。

若要進行 **無公共暴露** 的強化部署，請使用私有範本。

### 何時使用私有部署

-   您只進行 **出站** 呼叫/訊息 (無入站 webhooks)
-   您使用 **ngrok 或 Tailscale** 通道進行任何 webhook 回調
-   您透過 **SSH、代理或 WireGuard** 而非瀏覽器存取 Gateway
-   您希望部署 **隱藏於網路掃描器**

### 設定

使用 `fly.private.toml` 而非標準設定：

```bash
# Deploy with private config
fly deploy -c fly.private.toml
```

或轉換現有部署：

```bash
# 列出目前的 IP
fly ips list -a my-openclaw

# 釋放公共 IP
fly ips release <public-ipv4> -a my-openclaw
fly ips release <public-ipv6> -a my-openclaw

# 切換到私有設定，以便將來的部署不會重新分配公共 IP
# (移除 [http_service] 或使用私有範本部署)
fly deploy -c fly.private.toml

# 分配僅限私有的 IPv6
fly ips allocate-v6 --private -a my-openclaw
```

此後，`fly ips list` 應該只顯示 `private` 類型的 IP：

```
VERSION  IP                   TYPE             REGION
v6       fdaa:x:x:x:x::x      private          global
```

### 存取私有部署

由於沒有公共 URL，請使用以下方法之一：

**選項 1：本地代理 (最簡單)**

```bash
# 將本地連接埠 3000 轉發到應用程式
fly proxy 3000:3000 -a my-openclaw

# 然後在瀏覽器中開啟 http://localhost:3000
```

**選項 2：WireGuard VPN**

```bash
# 建立 WireGuard 設定 (一次性)
fly wireguard create

# 匯入 WireGuard 用戶端，然後透過內部 IPv6 存取
# 範例：http://[fdaa:x:x:x:x::x]:3000
```

**選項 3：僅限 SSH**

```bash
fly ssh console -a my-openclaw
```

### 私有部署的 Webhooks

如果您需要 webhook 回調 (Twilio、Telnyx 等) 而無需公共暴露：

1.  **ngrok 通道** - 在容器內部或作為 sidecar 運行 ngrok
2.  **Tailscale Funnel** - 透過 Tailscale 暴露特定路徑
3.  **僅限出站** - 某些供應商 (Twilio) 在沒有 webhooks 的情況下也能正常進行出站呼叫

附帶 ngrok 的語音通話設定範例：

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

ngrok 通道在容器內部運行，提供公共 webhook URL，而無需暴露 Fly 應用程式本身。將 `webhookSecurity.allowedHosts` 設定為公共通道主機名稱，以便轉發的主機標頭被接受。

### 安全優勢

| 層面            | 公有       | 私有       |
| :-------------- | :--------- | :--------- |
| 網路掃描器      | 可發現     | 隱藏       |
| 直接攻擊        | 可能       | 阻擋       |
| Control UI 存取 | 瀏覽器     | 代理/VPN   |
| Webhook 傳送    | 直接       | 透過通道   |

## 注意事項

-   Fly.io 使用 **x86 架構** (非 ARM)
-   Dockerfile 與兩種架構都相容
-   若要進行 WhatsApp/Telegram 新手導覽，請使用 `fly ssh console`
-   永久資料儲存在 `/data` 磁碟區上
-   Signal 需要 Java + signal-cli；使用自訂映像檔並將記憶體保持在 2GB+。

## 成本

使用建議設定 (`shared-cpu-2x`，2GB 記憶體)：

-   每月約 10-15 美元，取決於使用情況
-   免費方案包含一定額度

有關詳細資訊，請參閱 [Fly.io 定價](https://fly.io/docs/about/pricing/)。
