---
title: Fly.io
description: Deploy OpenClaw on Fly.io
---

# Triển khai Fly.io

**Mục tiêu:** OpenClaw Gateway chạy trên một máy [Fly.io](https://fly.io) với lưu trữ bền vững, HTTPS tự động và quyền truy cập Discord/kênh.

## Những gì bạn cần

- [flyctl CLI](https://fly.io/docs/hands-on/install-flyctl/) đã cài đặt
- Tài khoản Fly.io (gói miễn phí dùng được)
- Xác thực mô hình: khóa API Anthropic (hoặc khóa của nhà cung cấp khác)
- Thông tin xác thực kênh: token bot Discord, token Telegram, v.v.

## Lộ trình nhanh cho người mới

1. Clone repo → tùy chỉnh `fly.toml`
2. Tạo app + volume → đặt secrets
3. Triển khai bằng `fly deploy`
4. SSH vào để tạo cấu hình hoặc dùng Control UI

## 1) Tạo app Fly

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

## 2. Cấu hình fly.toml

Chỉnh sửa `fly.toml` để khớp với tên app và yêu cầu của bạn.

**Security note:** The default config exposes a public URL. For a hardened deployment with no public IP, see [Private Deployment](#private-deployment-hardened) or use `fly.private.toml`.

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

**Thiết lập chính:**

| Thiết lập                      | Lý do                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `--bind lan`                   | Gắn vào `0.0.0.0` để proxy của Fly có thể truy cập gateway                                             |
| `--allow-unconfigured`         | Khởi động không cần file cấu hình (bạn sẽ tạo sau)                                  |
| `internal_port = 3000`         | Phải khớp với `--port 3000` (hoặc `OPENCLAW_GATEWAY_PORT`) cho health check của Fly |
| `memory = "2048mb"`            | 512MB là quá ít; khuyến nghị 2GB                                                                       |
| `OPENCLAW_STATE_DIR = "/data"` | Lưu trạng thái trên volume                                                                             |

## 3. Đặt secrets

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

**Ghi chú:**

- Bind không phải loopback (`--bind lan`) yêu cầu `OPENCLAW_GATEWAY_TOKEN` để bảo mật.
- Hãy coi các token này như mật khẩu.
- **Prefer env vars over config file** for all API keys and tokens. This keeps secrets out of `openclaw.json` where they could be accidentally exposed or logged.

## 4. Triển khai

```bash
fly deploy
```

Lần triển khai đầu tiên sẽ build Docker image (~2–3 phút). Subsequent deploys are faster.

Sau khi triển khai, xác minh:

```bash
fly status
fly logs
```

Bạn sẽ thấy:

```
[gateway] listening on ws://0.0.0.0:3000 (PID xxx)
[discord] logged in to discord as xxx
```

## 5. Tạo file cấu hình

SSH vào máy để tạo cấu hình phù hợp:

```bash
fly ssh console
```

Tạo thư mục và file cấu hình:

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

**Lưu ý:** Với `OPENCLAW_STATE_DIR=/data`, đường dẫn cấu hình là `/data/openclaw.json`.

**Lưu ý:** Token Discord có thể đến từ một trong hai nguồn:

- Biến môi trường: `DISCORD_BOT_TOKEN` (khuyến nghị cho bí mật)
- File cấu hình: `channels.discord.token`

If using env var, no need to add token to config. Gateway tự động đọc `DISCORD_BOT_TOKEN`.

Khởi động lại để áp dụng:

```bash
exit
fly machine restart <machine-id>
```

## 6. Truy cập Gateway

### Control UI

Mở trên trình duyệt:

```bash
fly open
```

Hoặc truy cập `https://my-openclaw.fly.dev/`

Dán token gateway của bạn (token từ `OPENCLAW_GATEWAY_TOKEN`) để xác thực.

### Logs

```bash
fly logs              # Live logs
fly logs --no-tail    # Recent logs
```

### SSH Console

```bash
fly ssh console
```

## Xử lý sự cố

### "App is not listening on expected address"

Gateway đang bind vào `127.0.0.1` thay vì `0.0.0.0`.

**Cách khắc phục:** Thêm `--bind lan` vào lệnh process trong `fly.toml`.

### Health check thất bại / connection refused

Fly không thể truy cập gateway trên cổng đã cấu hình.

**Cách khắc phục:** Đảm bảo `internal_port` khớp với cổng gateway (đặt `--port 3000` hoặc `OPENCLAW_GATEWAY_PORT=3000`).

### OOM / Vấn đề bộ nhớ

Container keeps restarting or getting killed. Signs: `SIGABRT`, `v8::internal::Runtime_AllocateInYoungGeneration`, or silent restarts.

**Cách khắc phục:** Tăng bộ nhớ trong `fly.toml`:

```toml
[[vm]]
  memory = "2048mb"
```

Hoặc cập nhật một máy hiện có:

```bash
fly machine update <machine-id> --vm-memory 2048 -y
```

**Note:** 512MB is too small. 1GB may work but can OOM under load or with verbose logging. **Khuyến nghị 2GB.**

### Sự cố khóa Gateway

Gateway từ chối khởi động với lỗi "already running".

Điều này xảy ra khi container khởi động lại nhưng file khóa PID vẫn tồn tại trên volume.

**Cách khắc phục:** Xóa file khóa:

```bash
fly ssh console --command "rm -f /data/gateway.*.lock"
fly machine restart <machine-id>
```

File khóa nằm tại `/data/gateway.*.lock` (không nằm trong thư mục con).

### Cấu hình không được đọc

Nếu dùng `--allow-unconfigured`, gateway sẽ tạo một cấu hình tối thiểu. Your custom config at `/data/openclaw.json` should be read on restart.

Xác minh cấu hình tồn tại:

```bash
fly ssh console --command "cat /data/openclaw.json"
```

### Ghi cấu hình qua SSH

The `fly ssh console -C` command doesn't support shell redirection. Để ghi một file cấu hình:

```bash
# Use echo + tee (pipe from local to remote)
echo '{"your":"config"}' | fly ssh console -C "tee /data/openclaw.json"

# Or use sftp
fly sftp shell
> put /local/path/config.json /data/openclaw.json
```

**Lưu ý:** `fly sftp` có thể thất bại nếu file đã tồn tại. Delete first:

```bash
fly ssh console --command "rm /data/openclaw.json"
```

### Trạng thái không được lưu

Nếu bạn mất thông tin xác thực hoặc phiên sau khi khởi động lại, thư mục trạng thái đang ghi vào filesystem của container.

**Cách khắc phục:** Đảm bảo `OPENCLAW_STATE_DIR=/data` được đặt trong `fly.toml` và triển khai lại.

## Cập nhật

```bash
# Pull latest changes
git pull

# Redeploy
fly deploy

# Check health
fly status
fly logs
```

### Cập nhật lệnh máy

Nếu bạn cần thay đổi lệnh khởi động mà không triển khai lại toàn bộ:

```bash
# Get machine ID
fly machines list

# Update command
fly machine update <machine-id> --command "node dist/index.js gateway --port 3000 --bind lan" -y

# Or with memory increase
fly machine update <machine-id> --vm-memory 2048 --command "node dist/index.js gateway --port 3000 --bind lan" -y
```

**Lưu ý:** Sau `fly deploy`, lệnh máy có thể reset về giá trị trong `fly.toml`. If you made manual changes, re-apply them after deploy.

## Triển khai riêng tư (Gia cố)

By default, Fly allocates public IPs, making your gateway accessible at `https://your-app.fly.dev`. This is convenient but means your deployment is discoverable by internet scanners (Shodan, Censys, etc.).

Để triển khai được gia cố với **không phơi bày công khai**, hãy dùng mẫu riêng tư.

### Khi nào nên dùng triển khai riêng tư

- Bạn chỉ thực hiện **cuộc gọi/tin nhắn outbound** (không có webhook inbound)
- Bạn dùng **ngrok hoặc Tailscale** cho mọi callback webhook
- Bạn truy cập gateway qua **SSH, proxy, hoặc WireGuard** thay vì trình duyệt
- Bạn muốn triển khai **ẩn khỏi các trình quét internet**

### Thiết lập

Dùng `fly.private.toml` thay cho cấu hình tiêu chuẩn:

```bash
# Deploy with private config
fly deploy -c fly.private.toml
```

Hoặc chuyển đổi một triển khai hiện có:

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

Sau đó, `fly ips list` chỉ nên hiển thị IP kiểu `private`:

```
VERSION  IP                   TYPE             REGION
v6       fdaa:x:x:x:x::x      private          global
```

### Truy cập triển khai riêng tư

Vì không có URL công khai, hãy dùng một trong các cách sau:

**Tùy chọn 1: Proxy cục bộ (đơn giản nhất)**

```bash
# Forward local port 3000 to the app
fly proxy 3000:3000 -a my-openclaw

# Then open http://localhost:3000 in browser
```

**Tùy chọn 2: WireGuard VPN**

```bash
# Create WireGuard config (one-time)
fly wireguard create

# Import to WireGuard client, then access via internal IPv6
# Example: http://[fdaa:x:x:x:x::x]:3000
```

**Tùy chọn 3: Chỉ SSH**

```bash
fly ssh console -a my-openclaw
```

### Webhook với triển khai riêng tư

If you need webhook callbacks (Twilio, Telnyx, etc.) without public exposure:

1. **Đường hầm ngrok** – Chạy ngrok bên trong container hoặc như một sidecar
2. **Tailscale Funnel** – Mở các đường dẫn cụ thể qua Tailscale
3. **Chỉ outbound** – Một số nhà cung cấp (Twilio) hoạt động tốt cho outbound mà không cần webhook

Ví dụ cấu hình gọi thoại với ngrok:

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

The ngrok tunnel runs inside the container and provides a public webhook URL without exposing the Fly app itself. Set `webhookSecurity.allowedHosts` to the public tunnel hostname so forwarded host headers are accepted.

### Lợi ích bảo mật

| Khía cạnh           | Công khai        | Riêng tư      |
| ------------------- | ---------------- | ------------- |
| Trình quét internet | Có thể phát hiện | Ẩn            |
| Tấn công trực tiếp  | Có thể           | Bị chặn       |
| Truy cập Control UI | Trình duyệt      | Proxy/VPN     |
| Giao webhook        | Trực tiếp        | Qua đường hầm |

## Ghi chú

- Fly.io dùng **kiến trúc x86** (không phải ARM)
- Dockerfile tương thích với cả hai kiến trúc
- Với onboarding WhatsApp/Telegram, dùng `fly ssh console`
- Dữ liệu bền vững nằm trên volume tại `/data`
- Signal yêu cầu Java + signal-cli; dùng image tùy chỉnh và giữ bộ nhớ ở mức 2GB+.

## Chi phí

Với cấu hình khuyến nghị (`shared-cpu-2x`, RAM 2GB):

- ~$10–15/tháng tùy mức sử dụng
- Gói miễn phí có bao gồm một phần hạn mức

Xem [bảng giá Fly.io](https://fly.io/docs/about/pricing/) để biết chi tiết.
