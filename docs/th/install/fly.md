---
title: Fly.io
description: ดีพลอยOpenClawบนFly.io
---

# Fly.io Deployment

**เป้าหมาย:** ให้OpenClaw Gatewayทำงานบนเครื่องของ[Fly.io](https://fly.io)พร้อมพื้นที่เก็บข้อมูลถาวร, HTTPSอัตโนมัติ และการเข้าถึงDiscord/ช่องทางต่างๆ

## สิ่งที่ต้องใช้

- ติดตั้ง[flyctl CLI](https://fly.io/docs/hands-on/install-flyctl/)แล้ว
- บัญชีFly.io(ระดับฟรีใช้งานได้)
- การยืนยันตัวตนของโมเดล: คีย์APIของAnthropic(หรือคีย์ของผู้ให้บริการอื่น)
- Channel credentials: Discord bot token, Telegram token, etc.

## เส้นทางเริ่มต้นสำหรับผู้เริ่มต้น

1. โคลนรีโป → ปรับแต่ง`fly.toml`
2. สร้างแอป+โวลุ่ม → ตั้งค่าSecrets
3. ดีพลอยด้วย`fly deploy`
4. SSHเข้าไปเพื่อสร้างคอนฟิกหรือใช้Control UI

## 1) สร้างแอปFly

```bash
# Clone the repo
git clone https://github.com/openclaw/openclaw.git
cd openclaw

# Create a new Fly app (pick your own name)
fly apps create my-openclaw

# Create a persistent volume (1GB is usually enough)
fly volumes create openclaw_data --size 1 --region iad
```

**เคล็ดลับ:** เลือกภูมิภาคที่ใกล้คุณ ตัวเลือกที่พบบ่อย: `lhr`(ลอนดอน), `iad`(เวอร์จิเนีย), `sjc`(ซานโฮเซ) Common options: `lhr` (London), `iad` (Virginia), `sjc` (San Jose).

## 2. กำหนดค่าfly.toml

แก้ไข`fly.toml`ให้ตรงกับชื่อแอปและความต้องการของคุณ

**Security note:** The default config exposes a public URL. **หมายเหตุด้านความปลอดภัย:** คอนฟิกเริ่มต้นจะเปิดเผยURLสาธารณะ สำหรับการดีพลอยที่แข็งแกร่งโดยไม่มีIPสาธารณะ ดู[การดีพลอยแบบส่วนตัว](#private-deployment-hardened)หรือใช้`fly.private.toml`.

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

**การตั้งค่าหลัก:**

| การตั้งค่า                     | เหตุผล                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------ |
| `--bind lan`                   | ผูกกับ`0.0.0.0`เพื่อให้พร็อกซีของFlyเข้าถึงGatewayได้                                            |
| `--allow-unconfigured`         | เริ่มต้นโดยไม่มีไฟล์คอนฟิก(คุณจะสร้างภายหลัง)                                 |
| `internal_port = 3000`         | ต้องตรงกับ`--port 3000`(หรือ`OPENCLAW_GATEWAY_PORT`)สำหรับการตรวจสุขภาพของFly |
| `memory = "2048mb"`            | 512MBเล็กเกินไป แนะนำ2GB                                                                         |
| `OPENCLAW_STATE_DIR = "/data"` | Persists state on the volume                                                                     |

## 3. ตั้งค่าSecrets

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

**หมายเหตุ:**

- การผูกแบบไม่ใช่loopback(`--bind lan`)ต้องใช้`OPENCLAW_GATEWAY_TOKEN`เพื่อความปลอดภัย
- ปฏิบัติกับโทเคนเหล่านี้เหมือนรหัสผ่าน
- **Prefer env vars over config file** for all API keys and tokens. This keeps secrets out of `openclaw.json` where they could be accidentally exposed or logged.

## 4. ดีพลอย

```bash
fly deploy
```

การดีพลอยครั้งแรกจะสร้างอิมเมจDocker(~2-3นาที) การดีพลอยครั้งถัดไปจะเร็วขึ้น Subsequent deploys are faster.

หลังดีพลอย ให้ตรวจสอบ:

```bash
fly status
fly logs
```

คุณควรเห็น:

```
[gateway] listening on ws://0.0.0.0:3000 (PID xxx)
[discord] logged in to discord as xxx
```

## 5. สร้างไฟล์คอนฟิก

SSHเข้าเครื่องเพื่อสร้างคอนฟิกที่เหมาะสม:

```bash
fly ssh console
```

สร้างไดเรกทอรีและไฟล์คอนฟิก:

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

**หมายเหตุ:** เมื่อใช้`OPENCLAW_STATE_DIR=/data`พาธของคอนฟิกคือ`/data/openclaw.json`.

**หมายเหตุ:** โทเคนDiscordสามารถมาจากอย่างใดอย่างหนึ่ง:

- ตัวแปรสภาพแวดล้อม: `DISCORD_BOT_TOKEN`(แนะนำสำหรับSecrets)
- ไฟล์คอนฟิก: `channels.discord.token`

If using env var, no need to add token to config. The gateway reads `DISCORD_BOT_TOKEN` automatically.

รีสตาร์ตเพื่อให้มีผล:

```bash
exit
fly machine restart <machine-id>
```

## 6. เข้าถึงGateway

### Control UI

เปิดในเบราว์เซอร์:

```bash
fly open
```

หรือไปที่`https://my-openclaw.fly.dev/`

วางโทเคนGatewayของคุณ(อันที่ได้จาก`OPENCLAW_GATEWAY_TOKEN`)เพื่อยืนยันตัวตน

### Logs

```bash
fly logs              # Live logs
fly logs --no-tail    # Recent logs
```

### คอนโซลSSH

```bash
fly ssh console
```

## การแก้ไขปัญหา

### "App is not listening on expected address"

Gatewayกำลังผูกกับ`127.0.0.1`แทนที่จะเป็น`0.0.0.0`.

**วิธีแก้ไข:** เพิ่ม`--bind lan`ไปยังคำสั่งโปรเซสใน`fly.toml`.

### Health checksล้มเหลว/การเชื่อมต่อถูกปฏิเสธ

Flyไม่สามารถเข้าถึงGatewayบนพอร์ตที่กำหนดไว้ได้

**วิธีแก้ไข:** ตรวจสอบให้แน่ใจว่า`internal_port`ตรงกับพอร์ตของGateway(ตั้งค่า`--port 3000`หรือ`OPENCLAW_GATEWAY_PORT=3000`).

### OOM/ปัญหาหน่วยความจำ

Container keeps restarting or getting killed. คอนเทนเนอร์รีสตาร์ตซ้ำหรือถูกฆ่า สัญญาณ: `SIGABRT`, `v8::internal::Runtime_AllocateInYoungGeneration`หรือรีสตาร์ตแบบเงียบ

**วิธีแก้ไข:** เพิ่มหน่วยความจำใน`fly.toml`:

```toml
[[vm]]
  memory = "2048mb"
```

หรืออัปเดตเครื่องที่มีอยู่:

```bash
fly machine update <machine-id> --vm-memory 2048 -y
```

**หมายเหตุ:** 512MBเล็กเกินไป 1GBอาจใช้ได้แต่มีโอกาสOOMเมื่อมีโหลดหรือบันทึกแบบละเอียด **แนะนำ2GB** 1GB may work but can OOM under load or with verbose logging. **2GB is recommended.**

### ปัญหาGateway Lock

Gatewayปฏิเสธการเริ่มต้นพร้อมข้อผิดพลาด"already running"

เกิดขึ้นเมื่อคอนเทนเนอร์รีสตาร์ตแต่ไฟล์ล็อกPIDคงอยู่บนโวลุ่ม

**วิธีแก้ไข:** ลบไฟล์ล็อก:

```bash
fly ssh console --command "rm -f /data/gateway.*.lock"
fly machine restart <machine-id>
```

ไฟล์ล็อกอยู่ที่`/data/gateway.*.lock`(ไม่อยู่ในไดเรกทอรีย่อย)

### ไม่อ่านคอนฟิก

If using `--allow-unconfigured`, the gateway creates a minimal config. หากใช้`--allow-unconfigured`Gatewayจะสร้างคอนฟิกขั้นต่ำ คอนฟิกที่กำหนดเองของคุณที่`/data/openclaw.json`ควรถูกอ่านหลังรีสตาร์ต

ตรวจสอบว่ามีคอนฟิกอยู่จริง:

```bash
fly ssh console --command "cat /data/openclaw.json"
```

### การเขียนคอนฟิกผ่านSSH

คำสั่ง`fly ssh console -C`ไม่รองรับการเปลี่ยนเส้นทางเชลล์ เพื่อเขียนไฟล์คอนฟิก: To write a config file:

```bash
# Use echo + tee (pipe from local to remote)
echo '{"your":"config"}' | fly ssh console -C "tee /data/openclaw.json"

# Or use sftp
fly sftp shell
> put /local/path/config.json /data/openclaw.json
```

**หมายเหตุ:** `fly sftp`อาจล้มเหลวหากไฟล์มีอยู่แล้ว ให้ลบก่อน: ลบก่อน:

```bash
fly ssh console --command "rm /data/openclaw.json"
```

### สถานะไม่คงอยู่

หากคุณสูญเสียข้อมูลประจำตัวหรือเซสชันหลังรีสตาร์ต แสดงว่าไดเรกทอรีสถานะกำลังเขียนไปยังไฟล์ระบบของคอนเทนเนอร์

**วิธีแก้ไข:** ตรวจสอบให้แน่ใจว่าตั้งค่า`OPENCLAW_STATE_DIR=/data`ใน`fly.toml`แล้วดีพลอยใหม่

## อัปเดต

```bash
# Pull latest changes
git pull

# Redeploy
fly deploy

# Check health
fly status
fly logs
```

### อัปเดตคำสั่งเครื่อง

หากต้องการเปลี่ยนคำสั่งเริ่มต้นโดยไม่ดีพลอยใหม่ทั้งหมด:

```bash
# Get machine ID
fly machines list

# Update command
fly machine update <machine-id> --command "node dist/index.js gateway --port 3000 --bind lan" -y

# Or with memory increase
fly machine update <machine-id> --vm-memory 2048 --command "node dist/index.js gateway --port 3000 --bind lan" -y
```

**หมายเหตุ:** หลังจาก`fly deploy`คำสั่งของเครื่องอาจรีเซ็ตกลับเป็นค่าที่อยู่ใน`fly.toml` หากคุณแก้ไขด้วยตนเอง ให้ปรับใช้ซ้ำหลังดีพลอย If you made manual changes, re-apply them after deploy.

## การดีพลอยแบบส่วนตัว(Hardened)

โดยค่าเริ่มต้น FlyจะจัดสรรIPสาธารณะ ทำให้Gatewayของคุณเข้าถึงได้ที่`https://your-app.fly.dev` ซึ่งสะดวกแต่ทำให้การดีพลอยของคุณถูกค้นพบโดยสแกนเนอร์อินเทอร์เน็ต(Shodan, Censys ฯลฯ) This is convenient but means your deployment is discoverable by internet scanners (Shodan, Censys, etc.).

สำหรับการดีพลอยที่แข็งแกร่งโดย**ไม่มีการเปิดเผยสาธารณะ**ให้ใช้เทมเพลตแบบส่วนตัว

### เมื่อใดควรใช้การดีพลอยแบบส่วนตัว

- คุณทำเฉพาะการเรียก/ส่งข้อความแบบ**ขาออก**(ไม่มีเว็บฮุคขาเข้า)
- คุณใช้ท่อทาง**ngrokหรือTailscale**สำหรับการเรียกกลับของเว็บฮุค
- คุณเข้าถึงGatewayผ่าน**SSH, พร็อกซีหรือWireGuard**แทนเบราว์เซอร์
- คุณต้องการให้การดีพลอย**ซ่อนจากสแกนเนอร์อินเทอร์เน็ต**

### การตั้งค่า

ใช้`fly.private.toml`แทนคอนฟิกมาตรฐาน:

```bash
# Deploy with private config
fly deploy -c fly.private.toml
```

หรือแปลงการดีพลอยที่มีอยู่:

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

หลังจากนี้`fly ips list`ควรแสดงเฉพาะIPชนิด`private`:

```
VERSION  IP                   TYPE             REGION
v6       fdaa:x:x:x:x::x      private          global
```

### การเข้าถึงการดีพลอยแบบส่วนตัว

เนื่องจากไม่มีURLสาธารณะ ให้ใช้หนึ่งในวิธีต่อไปนี้:

**ตัวเลือกที่1: พร็อกซีภายในเครื่อง(ง่ายที่สุด)**

```bash
# Forward local port 3000 to the app
fly proxy 3000:3000 -a my-openclaw

# Then open http://localhost:3000 in browser
```

**ตัวเลือกที่2: WireGuard VPN**

```bash
# Create WireGuard config (one-time)
fly wireguard create

# Import to WireGuard client, then access via internal IPv6
# Example: http://[fdaa:x:x:x:x::x]:3000
```

**ตัวเลือกที่3: เฉพาะSSH**

```bash
fly ssh console -a my-openclaw
```

### เว็บฮุคกับการดีพลอยแบบส่วนตัว

If you need webhook callbacks (Twilio, Telnyx, etc.) without public exposure:

1. **ngrok tunnel** - รันngrokภายในคอนเทนเนอร์หรือเป็นไซด์คาร์
2. **Tailscale Funnel** - เปิดเผยพาธเฉพาะผ่านTailscale
3. **ขาออกเท่านั้น** - ผู้ให้บริการบางราย(Twilio)ทำงานได้ดีสำหรับการโทรขาออกโดยไม่ต้องมีเว็บฮุค

ตัวอย่างคอนฟิกการโทรด้วยเสียงโดยใช้ngrok:

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

The ngrok tunnel runs inside the container and provides a public webhook URL without exposing the Fly app itself. ngrok tunnelทำงานภายในคอนเทนเนอร์และให้URLเว็บฮุคสาธารณะโดยไม่เปิดเผยแอปFlyเอง ตั้งค่า`webhookSecurity.allowedHosts`เป็นชื่อโฮสต์ของท่อทางสาธารณะเพื่อยอมรับส่วนหัวโฮสต์ที่ถูกส่งต่อ

### ประโยชน์ด้านความปลอดภัย

| Aspect                | สาธารณะ     | ส่วนตัว     |
| --------------------- | ----------- | ----------- |
| สแกนเนอร์อินเทอร์เน็ต | ค้นพบได้    | ซ่อนอยู่    |
| การโจมตีโดยตรง        | เป็นไปได้   | ถูกบล็อก    |
| การเข้าถึงControl UI  | เบราว์เซอร์ | พร็อกซี/VPN |
| การส่งเว็บฮุค         | โดยตรง      | ผ่านท่อทาง  |

## หมายเหตุ

- Fly.ioใช้**สถาปัตยกรรมx86**(ไม่ใช่ARM)
- Dockerfileรองรับทั้งสองสถาปัตยกรรม
- สำหรับการเริ่มต้นใช้งานWhatsApp/Telegramให้ใช้`fly ssh console`
- ข้อมูลถาวรอยู่บนโวลุ่มที่`/data`
- Signalต้องใช้Java+signal-cli; ใช้อิมเมจแบบกำหนดเองและคงหน่วยความจำไว้ที่2GBขึ้นไป

## ค่าใช้จ่าย

ด้วยคอนฟิกที่แนะนำ(`shared-cpu-2x`, RAM2GB):

- ประมาณ$10-15/เดือนขึ้นอยู่กับการใช้งาน
- ระดับฟรีมีโควตาบางส่วน

ดูรายละเอียดที่[ราคาFly.io](https://fly.io/docs/about/pricing/)
