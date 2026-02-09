---
title: Fly.io
description: Deploy OpenClaw on Fly.io
---

# Fly.io 部署

**目標：** 在 [Fly.io](https://fly.io) 的機器上執行 OpenClaw Gateway 閘道器，具備持久化儲存、自動 HTTPS，以及 Discord／頻道存取。

## What you need

- 已安裝 [flyctl CLI](https://fly.io/docs/hands-on/install-flyctl/)
- Fly.io 帳戶（免費方案即可）
- 模型身分驗證：Anthropic API 金鑰（或其他提供者金鑰）
- Channel credentials: Discord bot token, Telegram token, etc.

## 新手快速路徑

1. 複製 repo → 自訂 `fly.toml`
2. 建立 app 與 volume → 設定 secrets
3. 使用 `fly deploy` 部署
4. SSH 進入建立設定，或使用 Control UI

## 1) 建立 Fly app

```bash
# Clone the repo
git clone https://github.com/openclaw/openclaw.git
cd openclaw

# Create a new Fly app (pick your own name)
fly apps create my-openclaw

# Create a persistent volume (1GB is usually enough)
fly volumes create openclaw_data --size 1 --region iad
```

**Tip:** Choose a region close to you. Common options: `lhr` (London), `iad` (Virginia), `sjc` (San Jose).

## 2. 設定 fly.toml

編輯 `fly.toml` 以符合你的 app 名稱與需求。

**Security note:** The default config exposes a public URL. **安全性注意事項：** 預設設定會暴露公開 URL。若要進行沒有公開 IP 的強化部署，請參考 [Private Deployment](#private-deployment-hardened) 或使用 `fly.private.toml`。

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

**關鍵設定：**

| 設定                             | 原因                                                          |
| ------------------------------ | ----------------------------------------------------------- |
| `--bind lan`                   | 綁定至 `0.0.0.0`，讓 Fly 的 proxy 能夠連線到 Gateway 閘道器               |
| `--allow-unconfigured`         | 在沒有設定檔的情況下啟動（之後你會建立）                                        |
| `internal_port = 3000`         | 必須與 `--port 3000`（或 `OPENCLAW_GATEWAY_PORT`）相符，供 Fly 健康檢查使用 |
| `memory = "2048mb"`            | 512MB 太小；建議 2GB                                             |
| `OPENCLAW_STATE_DIR = "/data"` | 在 volume 上持久化狀態                                             |

## 3. 設定 secrets

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

- 非 loopback 綁定（`--bind lan`）為了安全性需要 `OPENCLAW_GATEWAY_TOKEN`。
- Treat these tokens like passwords.
- **Prefer env vars over config file** for all API keys and tokens. This keeps secrets out of `openclaw.json` where they could be accidentally exposed or logged.

## 4. 部署

```bash
fly deploy
```

第一次部署會建置 Docker 映像（約 2–3 分鐘）。後續部署會更快。 Subsequent deploys are faster.

部署後，請驗證：

```bash
fly status
fly logs
```

你應該會看到：

```
[gateway] listening on ws://0.0.0.0:3000 (PID xxx)
[discord] logged in to discord as xxx
```

## 5. 建立設定檔

透過 SSH 進入機器以建立正式的設定檔：

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

**注意：** 使用 `OPENCLAW_STATE_DIR=/data` 時，設定路徑為 `/data/openclaw.json`。

**注意：** Discord 權杖可來自以下其中一種：

- 環境變數：`DISCORD_BOT_TOKEN`（建議用於 secrets）
- 設定檔：`channels.discord.token`

If using env var, no need to add token to config. 閘道會自動讀取 `DISCORD_BOT_TOKEN`。

重新啟動以套用：

```bash
exit
fly machine restart <machine-id>
```

## 6. 存取 Gateway 閘道器

### Control UI

在瀏覽器中開啟：

```bash
fly open
```

或造訪 `https://my-openclaw.fly.dev/`

貼上你的 Gateway 權杖（來自 `OPENCLAW_GATEWAY_TOKEN`）以進行身分驗證。

### Logs

```bash
fly logs              # Live logs
fly logs --no-tail    # Recent logs
```

### SSH 主控台

```bash
fly ssh console
```

## 疑難排解

### 「App is not listening on expected address」

Gateway 閘道器綁定到 `127.0.0.1`，而非 `0.0.0.0`。

**修正：** 在 `fly.toml` 的程序命令中加入 `--bind lan`。

### 健康檢查失敗／連線被拒

Fly 無法透過設定的連接埠連到 Gateway 閘道器。

**修正：** 確保 `internal_port` 與 Gateway 連接埠相符（設定 `--port 3000` 或 `OPENCLAW_GATEWAY_PORT=3000`）。

### OOM／記憶體問題

Container keeps restarting or getting killed. 容器持續重新啟動或被終止。徵兆：`SIGABRT`、`v8::internal::Runtime_AllocateInYoungGeneration`，或無聲重新啟動。

**修正：** 在 `fly.toml` 中提高記憶體：

```toml
[[vm]]
  memory = "2048mb"
```

或更新既有機器：

```bash
fly machine update <machine-id> --vm-memory 2048 -y
```

**注意：** 512MB 太小。1GB 可能可用，但在負載或詳細記錄下可能 OOM。**建議 2GB。** 25. 1GB 可能可行，但在高負載或詳細記錄日誌時可能會發生 OOM。 **建議使用 2GB。**

### Gateway 鎖定問題

Gateway 閘道器因「already running」錯誤而拒絕啟動。

當容器重新啟動但 PID 鎖定檔仍留在 volume 上時會發生。

**修正：** 刪除鎖定檔：

```bash
fly ssh console --command "rm -f /data/gateway.*.lock"
fly machine restart <machine-id>
```

鎖定檔位於 `/data/gateway.*.lock`（不在子目錄中）。

### 設定未被讀取

如果使用 `--allow-unconfigured`，閘道會建立最小設定。 若使用 `--allow-unconfigured`，Gateway 閘道器會建立最小設定。你在 `/data/openclaw.json` 的自訂設定應在重新啟動後被讀取。

請確認設定存在：

```bash
fly ssh console --command "cat /data/openclaw.json"
```

### 透過 SSH 寫入設定

`fly ssh console -C` 指令不支援 shell 重新導向。要寫入設定檔： 28. 要寫入設定檔：

```bash
# Use echo + tee (pipe from local to remote)
echo '{"your":"config"}' | fly ssh console -C "tee /data/openclaw.json"

# Or use sftp
fly sftp shell
> put /local/path/config.json /data/openclaw.json
```

**注意：** 若檔案已存在，`fly sftp` 可能失敗。請先刪除： 29. 請先刪除：

```bash
fly ssh console --command "rm /data/openclaw.json"
```

### 狀態未持久化

31. 若在重新啟動後遺失憑證或工作階段，表示狀態目錄正在寫入容器的檔案系統。

**修正：** 確保在 `fly.toml` 中設定 `OPENCLAW_STATE_DIR=/data`，然後重新部署。

## 更新

```bash
# Pull latest changes
git pull

# Redeploy
fly deploy

# Check health
fly status
fly logs
```

### 更新機器啟動命令

若需要在不完整重新部署的情況下變更啟動命令：

```bash
# Get machine ID
fly machines list

# Update command
fly machine update <machine-id> --command "node dist/index.js gateway --port 3000 --bind lan" -y

# Or with memory increase
fly machine update <machine-id> --vm-memory 2048 --command "node dist/index.js gateway --port 3000 --bind lan" -y
```

**注意：** 在 `fly deploy` 之後，機器命令可能會重設為 `fly.toml` 中的內容。若你做過手動變更，請在部署後重新套用。 32. 若你進行過手動變更，請在部署後重新套用。

## 私有部署（強化）

預設情況下，Fly 會配置公開 IP，使你的 Gateway 閘道器可透過 `https://your-app.fly.dev` 存取。這很方便，但代表你的部署可被網際網路掃描器（Shodan、Censys 等）發現。 34. 這很方便，但代表你的部署可被網路掃描器（Shodan、Censys 等）發現。

35. 若要進行 **無任何公開暴露** 的強化部署，請使用私有範本。

### 何時使用私有部署

- 你只進行 **對外（outbound）** 呼叫／訊息（沒有 inbound webhook）
- 任何 webhook 回呼都使用 **ngrok 或 Tailscale** 通道
- 你透過 **SSH、proxy 或 WireGuard** 存取 Gateway 閘道器，而非瀏覽器
- 你希望部署 **隱藏於網際網路掃描器**

### 設定

使用 `fly.private.toml` 取代標準設定：

```bash
# Deploy with private config
fly deploy -c fly.private.toml
```

或將既有部署轉換：

```bash
# List current IPs
fly ips list -a my-openclaw

# Release public IPs
fly ips release <public-ipv4> -a my-openclaw
fly ips release <public-ipv6> -a my-openclaw

# Switch to private config so future deploys don't re-allocate public IPs
# (remove [http_service] or deploy with the private template)
fly deploy -c fly.private.toml

# Allocate private-only IPv6
fly ips allocate-v6 --private -a my-openclaw
```

完成後，`fly ips list` 應只顯示 `private` 類型的 IP：

```
VERSION  IP                   TYPE             REGION
v6       fdaa:x:x:x:x::x      private          global
```

### 存取私有部署

由於沒有公開 URL，請使用以下其中一種方式：

**選項 1：本機 proxy（最簡單）**

```bash
# Forward local port 3000 to the app
fly proxy 3000:3000 -a my-openclaw

# Then open http://localhost:3000 in browser
```

**選項 2：WireGuard VPN**

```bash
# Create WireGuard config (one-time)
fly wireguard create

# Import to WireGuard client, then access via internal IPv6
# Example: http://[fdaa:x:x:x:x::x]:3000
```

**選項 3：僅 SSH**

```bash
fly ssh console -a my-openclaw
```

### 36. 私有部署的 Webhooks

若需要 webhook 回呼（Twilio、Telnyx 等）且不想對外公開： 37. 在沒有公開暴露的情況下：

1. **ngrok 通道**－在容器內或以 sidecar 執行 ngrok
2. **Tailscale Funnel**－透過 Tailscale 暴露特定路徑
3. **僅 outbound**－部分提供者（Twilio）在沒有 webhook 的情況下也可正常運作

使用 ngrok 的語音通話設定範例：

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

ngrok 通道在容器內執行，並提供公開的 webhook URL，而不會暴露 Fly app 本身。請將 `webhookSecurity.allowedHosts` 設為公開通道的主機名稱，以便接受轉送的 Host 標頭。 38. 將 `webhookSecurity.allowedHosts` 設為公開通道的主機名稱，以便接受轉送的 host header。

### 安全性效益

| 面向            | 公開   | 私有        |
| ------------- | ---- | --------- |
| 網際網路掃描器       | 可被發現 | 隱藏        |
| 直接攻擊          | 可能   | 被阻擋       |
| Control UI 存取 | 瀏覽器  | Proxy／VPN |
| Webhook 傳遞    | 直接   | 透過通道      |

## 注意事項

- Fly.io 使用 **x86 架構**（非 ARM）
- Dockerfile 相容於兩種架構
- WhatsApp／Telegram 入門引導請使用 `fly ssh console`
- 持久化資料位於 volume 的 `/data`
- Signal 需要 Java + signal-cli；請使用自訂映像並將記憶體維持在 2GB 以上。

## 成本

採用建議設定（`shared-cpu-2x`，2GB RAM）：

- 每月約 ~$10–15，視使用量而定
- 免費方案包含部分額度

詳情請見 [Fly.io 定價](https://fly.io/docs/about/pricing/)。
